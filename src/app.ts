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
import { TicketService } from '@services/ticket.service';
import { EventReminderService } from '@services/eventReminder.service';
import { reconcileStuckUpdates } from '@services/transcode.client';

// Import routes
import ticketsRoutes from '@routes/tickets.route';
import mediaRoutes from '@routes/media.route';
import publicRoutes from '@routes/public.route';
import momoRoutes from '@routes/momo.route';
import cardRoutes from '@routes/card.route';
import resellerRoutes from '@routes/reseller.route';
import resellerAdminRoutes from '@routes/resellerAdmin.route';
import operatorRoutes from '@routes/operator.route';
import communityRoutes from '@routes/community.route';
import socialRoutes from '@routes/social.route';
import dmRoutes from '@routes/dm.route';
import updateRoutes from '@routes/update.route';

// Realtime bus
import { ensureAdapterCollection } from '@/realtime/adapterCollection';
import { initSocketEmitter } from '@/realtime/emitter';

// Web Push (VAPID) — delivery-grade: missing env logs loudly but never
// crashes boot. See @config/vapid.config.
import { initWebPush } from '@config/vapid.config';

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
app.use('/api/public/updates', updateRoutes);          // Buyer updates (Discover feed) - mounted before the broader /api/public below
app.use('/api/public', publicRoutes);                  // Public routes - no auth required
app.use('/api/public/purchase/peach-card', cardRoutes);      // Peach card webhook (unauthenticated)
app.use('/api/momo', momoRoutes);                      // MTN MoMo callback (unauthenticated)
app.use('/api/operator', operatorRoutes);
app.use('/api/community', communityRoutes);          // Event communities (buyer social)
app.use('/api/social', socialRoutes);                // Buyer social profiles
app.use('/api/dm', dmRoutes);                        // Direct & group messages

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

      // Reconcile paid-but-stuck Peach card sales (return endpoint + webhook +
      // poll all missed). Runs ahead of the 15-min reservation expiry so a paid
      // sale is minted, never failed. See TicketService.reconcilePendingCardSales.
      const CARD_RECONCILE_MS = 60_000;
      setInterval(() => {
        TicketService.reconcilePendingCardSales().catch(err => console.error('[card-reconcile] error', err));
      }, CARD_RECONCILE_MS);

      // Event reminders (spec §6): T-24h and day-of pushes for ticket holders.
      const REMINDER_SWEEP_MS = 600_000;
      setInterval(() => {
        EventReminderService.sweep().catch((err) => console.error('[reminder-sweep] error', err));
      }, REMINDER_SWEEP_MS);

      // Discover feed: re-trigger or fail-loud-fail video updates stuck in
      // 'processing' (transcoder crashed/never called back). See
      // @services/transcode.client#reconcileStuckUpdates.
      const UPDATE_RECONCILE_MS = 120_000;
      setInterval(() => {
        reconcileStuckUpdates().catch((e) => console.error('update reconcile sweep failed:', e?.message));
      }, UPDATE_RECONCILE_MS);

      // Web Push (VAPID): missing keys log loudly and disable push, never
      // crash boot — see @config/vapid.config.
      initWebPush();

      // Realtime bus: REST-created messages broadcast to the gateway's
      // channel rooms. Init failure keeps the API serving (REST is this
      // service's job) but retries with backoff — a boot-time Mongo blip
      // must not permanently disable live delivery on this instance.
      const db = mongoose.connection.db;
      if (db) {
        const initEmitterWithRetry = (attempt: number): void => {
          ensureAdapterCollection(db as any)
            .then((collection) => {
              initSocketEmitter(collection);
              console.log('📡 Socket emitter ready (realtime broadcast enabled)');
            })
            .catch((err) => {
              const delayMs = Math.min(60_000, 2 ** attempt * 1_000);
              console.error(
                `❌ Socket emitter init failed (attempt ${attempt + 1}; retrying in ${delayMs / 1000}s; live broadcast disabled until then, resync still works):`,
                err
              );
              setTimeout(() => initEmitterWithRetry(attempt + 1), delayMs).unref();
            });
        };
        initEmitterWithRetry(0);
      }
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
