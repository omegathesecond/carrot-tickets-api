import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

// Import Sentry if available
let Sentry: any = null;
try {
  Sentry = require('@sentry/node');
} catch (error) {
  // Sentry not installed, continue without it
}

/**
 * Custom error class for application errors
 */
export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  code?: string | undefined;

  constructor(message: string, statusCode: number = 500, code?: string | undefined) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // Operational errors are expected and handled
    if (code !== undefined) {
      this.code = code;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Specific error classes for different scenarios
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT_ERROR');
  }
}

export class DatabaseError extends AppError {
  constructor(message: string = 'Database operation failed') {
    super(message, 500, 'DATABASE_ERROR');
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string = 'External service error', serviceName?: string) {
    super(message, 502, 'EXTERNAL_SERVICE_ERROR');
    this.code = serviceName ? `EXTERNAL_SERVICE_ERROR_${serviceName.toUpperCase()}` : 'EXTERNAL_SERVICE_ERROR';
  }
}

/**
 * Async error wrapper to catch errors in async route handlers
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Generate a unique request ID for tracking
 */
export const requestIdMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  next();
};

/**
 * Log error with structured information and report to Sentry
 */
const logError = (error: any, req: Request) => {
  const errorLog = {
    timestamp: new Date().toISOString(),
    requestId: (req as any).requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    error: {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      stack: error.stack,
      isOperational: error.isOperational
    },
    user: {
      userId: (req as any).vendorUser?.userId || (req as any).user?.userId,
      userType: (req as any).vendorUser?.userType || (req as any).user?.role
    }
  };

  // Console logging
  if (error.statusCode >= 500) {
    console.error('🔴 Server Error:', JSON.stringify(errorLog, null, 2));
  } else if (error.statusCode >= 400) {
    console.warn('⚠️  Client Error:', JSON.stringify(errorLog, null, 2));
  } else {
    console.log('ℹ️  Error:', JSON.stringify(errorLog, null, 2));
  }

  // Report to Sentry if available and it's a server error
  if (Sentry && error.statusCode >= 500) {
    Sentry.withScope((scope: any) => {
      // Add user context
      if (errorLog.user.userId) {
        scope.setUser({
          id: errorLog.user.userId,
          type: errorLog.user.userType,
        });
      }

      // Add request context
      scope.setContext('request', {
        method: req.method,
        url: req.url,
        query: req.query,
        requestId: (req as any).requestId,
      });

      // Add error context
      scope.setContext('error', {
        code: error.code,
        isOperational: error.isOperational,
      });

      // Set tags for filtering
      scope.setTag('error_code', error.code || 'UNKNOWN');
      scope.setTag('status_code', error.statusCode);
      scope.setTag('user_type', errorLog.user.userType || 'anonymous');

      // Set level based on status code
      if (error.statusCode >= 500) {
        scope.setLevel('error');
      } else if (error.statusCode >= 400) {
        scope.setLevel('warning');
      }

      // Capture exception
      Sentry.captureException(error);
    });
  }
};

/**
 * Handle Mongoose validation errors
 */
const handleMongooseValidationError = (error: mongoose.Error.ValidationError): AppError => {
  const errors = Object.values(error.errors).map(err => err.message);
  const message = `Validation failed: ${errors.join(', ')}`;
  return new ValidationError(message);
};

/**
 * Handle Mongoose duplicate key errors
 */
const handleMongoDuplicateKeyError = (error: any): AppError => {
  const keyValue = error.keyValue || {};
  const fields = Object.keys(keyValue);
  const field = fields[0];
  const value = field ? keyValue[field] : undefined;
  const message = field && value !== undefined
    ? `${field.charAt(0).toUpperCase() + field.slice(1)} '${value}' already exists`
    : 'Duplicate entry detected';
  return new ConflictError(message);
};

/**
 * Handle Mongoose cast errors (invalid ObjectId, etc.)
 */
const handleMongoCastError = (error: mongoose.Error.CastError): AppError => {
  const message = `Invalid ${error.path}: ${error.value}`;
  return new ValidationError(message);
};

/**
 * Handle JWT errors
 */
const handleJWTError = (): AppError => {
  return new AuthenticationError('Invalid token');
};

const handleJWTExpiredError = (): AppError => {
  return new AuthenticationError('Token expired');
};

/**
 * Comprehensive error handling middleware
 */
export const errorHandler = (
  error: any,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  // Log the error
  logError(error, req);

  let appError = error;

  // Convert known errors to AppError instances
  if (error.name === 'ValidationError' && error instanceof mongoose.Error.ValidationError) {
    appError = handleMongooseValidationError(error);
  } else if (error.code === 11000) {
    appError = handleMongoDuplicateKeyError(error);
  } else if (error.name === 'CastError' && error instanceof mongoose.Error.CastError) {
    appError = handleMongoCastError(error);
  } else if (error.name === 'JsonWebTokenError') {
    appError = handleJWTError();
  } else if (error.name === 'TokenExpiredError') {
    appError = handleJWTExpiredError();
  } else if (!(error instanceof AppError)) {
    // Unknown errors - treat as internal server errors
    appError = new AppError(
      process.env['NODE_ENV'] === 'production'
        ? 'Internal server error'
        : error.message || 'Something went wrong',
      error.statusCode || 500
    );
  }

  // Send error response
  const response: any = {
    success: false,
    message: appError.message,
    code: appError.code,
    requestId: (req as any).requestId
  };

  // Include stack trace in development
  if (process.env['NODE_ENV'] !== 'production') {
    response.stack = appError.stack;
  }

  // Include validation details if available
  if (error.details) {
    response.details = error.details;
  }

  res.status(appError.statusCode).json(response);
};

/**
 * Handle 404 errors
 */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
  const error = new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`);
  next(error);
};

/**
 * Handle uncaught exceptions
 */
export const handleUncaughtException = () => {
  process.on('uncaughtException', (error: Error) => {
    console.error('🔥 UNCAUGHT EXCEPTION! Shutting down...');
    console.error(error.name, error.message);
    console.error(error.stack);
    process.exit(1);
  });
};

/**
 * Handle unhandled promise rejections
 */
export const handleUnhandledRejection = () => {
  process.on('unhandledRejection', (reason: any) => {
    console.error('🔥 UNHANDLED REJECTION! Shutting down...');
    console.error(reason);
    process.exit(1);
  });
};
