import express, { Application, Request, Response } from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

// Load environment variables first
dotenv.config();

// Initialize Sentry BEFORE importing anything else
import { sentryConfig, isSentryEnabled } from '@config/sentry.config';
import { getDatabaseURI, logDatabaseConfig, validateEnvironment } from '@config/database.config';

// Conditionally import and initialize Sentry
let Sentry: any = null;
if (isSentryEnabled()) {
  try {
    Sentry = require('@sentry/node');
    const { ProfilingIntegration } = require('@sentry/profiling-node');

    Sentry.init({
      dsn: sentryConfig.dsn,
      environment: sentryConfig.environment,
      release: sentryConfig.release,
      tracesSampleRate: sentryConfig.tracesSampleRate,
      profilesSampleRate: sentryConfig.tracesSampleRate,
      debug: sentryConfig.debug,
      serverName: sentryConfig.serverName,
      beforeSend: sentryConfig.beforeSend,
      beforeBreadcrumb: sentryConfig.beforeBreadcrumb,
      ignoreErrors: sentryConfig.ignoreErrors,
      integrations: [
        new Sentry.Integrations.Http({ tracing: true }),
        new Sentry.Integrations.Express({ app: express() }),
        new Sentry.Integrations.Mongo({
          useMongoose: true,
        }),
        new ProfilingIntegration(),
      ],
    });
  } catch (error) {
    console.error('Failed to initialize Sentry:', error);
    Sentry = null;
  }
}

// Import services
import { ReservationService } from '@services/reservation.service';

// Import routes
import ticketsRoutes from '@routes/tickets.route';
import mediaRoutes from '@routes/media.route';
import publicRoutes from '@routes/public.route';
import momoRoutes from '@routes/momo.route';
import resellerRoutes from '@routes/reseller.route';
import resellerAdminRoutes from '@routes/resellerAdmin.route';
import operatorRoutes from '@routes/operator.route';

// Import error handling middleware
import {
  errorHandler,
  notFoundHandler,
  requestIdMiddleware,
  handleUncaughtException,
  handleUnhandledRejection
} from '@middleware/errorHandler.middleware';

// Import Swagger configuration
import { swaggerSpec } from '@config/swagger.config';

// Setup global error handlers
handleUncaughtException();
handleUnhandledRejection();

// Initialize Express app
const app: Application = express();

// Sentry request handler - MUST be first middleware
if (Sentry) {
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

// Middleware
app.use(requestIdMiddleware); // Add request ID for tracking
app.use(helmet()); // Security headers
app.use(compression()); // Compress responses

// CORS Configuration
const corsOriginsEnv = process.env['CORS_ORIGINS'] || '*';
const corsOrigins = corsOriginsEnv === '*' ? '*' : corsOriginsEnv.split(',');
app.use(cors({
  origin: corsOrigins,
  credentials: false
}));

app.use(express.json({ limit: '10mb' })); // Parse JSON bodies with size limit
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Parse URL-encoded bodies with limit

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Keshless Tickets API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API Documentation
const swaggerUiOptions = {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Keshless Tickets API Documentation',
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

// Swagger JSON endpoint
app.get('/api-docs.json', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// API Routes
app.use('/api/tickets', ticketsRoutes);
app.use('/api/reseller', resellerRoutes);
app.use('/api/admin', resellerAdminRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/public', publicRoutes);  // Public routes - no auth required
app.use('/api/momo', momoRoutes);      // MTN MoMo callback (unauthenticated)
app.use('/api/operator', operatorRoutes);

// 404 handler - must be after all routes
app.use(notFoundHandler);

// Sentry error handler - must be before custom error handler
if (Sentry) {
  app.use(Sentry.Handlers.errorHandler({
    shouldHandleError(error: any) {
      // Report all errors with status >= 500 to Sentry
      // Don't report client errors (4xx)
      return !error.statusCode || error.statusCode >= 500;
    },
  }));
}

// Global error handler - must be last
app.use(errorHandler);

// Export Sentry for use in other parts of the app
export { Sentry };

// Validate database configuration before connecting (skip in test env)
if (process.env['NODE_ENV'] !== 'test') {
  try {
    validateEnvironment();
  } catch (error) {
    process.exit(1);
  }
}

// MongoDB connection — skipped in test env; tests use connectTestDb() from helpers/mongo.ts
if (process.env['NODE_ENV'] !== 'test') {
  const MONGODB_URI = getDatabaseURI();

  mongoose
    .connect(MONGODB_URI)
    .then(() => {
      console.log('✅ Connected to MongoDB');
      console.log(`📦 Database: ${mongoose.connection.name}`);
      // Log detailed database configuration
      logDatabaseConfig();

      // Start the reservation expiry sweep
      const SWEEP_MS = 60_000;
      setInterval(() => {
        ReservationService.sweepExpired().catch(err => console.error('[reservation-sweep] error', err));
      }, SWEEP_MS);
    })
    .catch((error) => {
      console.error('❌ MongoDB connection error:', error);
      process.exit(1);
    });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing MongoDB connection...');
  mongoose.connection.close().then(() => {
    console.log('MongoDB connection closed');
    process.exit(0);
  });
});

// Start server — skipped in test env; supertest binds its own ephemeral port
if (process.env['NODE_ENV'] !== 'test') {
  const PORT = process.env['PORT'] || 5000;

  app.listen(PORT, () => {
    console.log('');
    console.log('🎫 ====================================== 🎫');
    console.log('   Keshless Tickets API Server');
    console.log('🎫 ====================================== 🎫');
    console.log('');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env['NODE_ENV'] || 'development'}`);
    console.log(`📍 Base URL: http://localhost:${PORT}`);
    console.log(`💚 Health check: http://localhost:${PORT}/health`);
    console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
    console.log(`🔗 API Endpoint: http://localhost:${PORT}/api`);
    console.log('');
  });
}

export default app;
