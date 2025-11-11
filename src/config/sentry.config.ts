/**
 * Sentry Configuration for Keshless Tickets API
 *
 * Environment Variables Required:
 * - SENTRY_DSN: Your Sentry project DSN
 * - NODE_ENV: Environment (development, staging, production)
 * - SENTRY_ENVIRONMENT: Optional custom environment name
 * - SENTRY_RELEASE: Optional release version
 */

export const sentryConfig = {
  // Sentry DSN - get this from your Sentry project settings
  dsn: process.env['SENTRY_DSN'] || '',

  // Environment name
  environment: process.env['SENTRY_ENVIRONMENT'] || process.env['NODE_ENV'] || 'development',

  // Release version - should match your deployment version
  release: process.env['SENTRY_RELEASE'] || `keshless-tickets-api@${process.env['npm_package_version'] || '1.0.0'}`,

  // Sample rate for error events (1.0 = 100%)
  sampleRate: 1.0,

  // Sample rate for transaction events (performance monitoring)
  // Lower in production to reduce costs
  tracesSampleRate: process.env['NODE_ENV'] === 'production' ? 0.1 : 1.0,

  // Enable/disable Sentry based on environment
  enabled: process.env['NODE_ENV'] !== 'test' && !!process.env['SENTRY_DSN'],

  // Debug mode - logs helpful information about Sentry
  debug: process.env['NODE_ENV'] === 'development',

  // Server name - useful for identifying which instance reported the error
  serverName: process.env['SERVER_NAME'] || 'keshless-tickets-api',

  // Integrations configuration
  integrations: {
    // Capture console errors
    captureConsole: true,

    // Capture unhandled promise rejections
    captureUnhandledRejections: true,

    // Capture uncaught exceptions
    captureUncaughtException: true,

    // HTTP request tracking
    http: true,

    // MongoDB query tracking
    mongo: true,

    // Express middleware tracking
    express: true,
  },

  // Ignore specific errors
  ignoreErrors: [
    // Browser errors that shouldn't affect backend
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',

    // Network errors
    'NetworkError',
    'Network request failed',

    // Expected operational errors
    'Invalid credentials',
    'Token expired',
  ],

  // Before sending to Sentry, scrub sensitive data
  beforeSend: (event: any) => {
    // Remove sensitive data from request body
    if (event.request?.data) {
      const data = event.request.data;

      // Remove password fields
      if (data.password) data.password = '[Filtered]';
      if (data.currentPassword) data.currentPassword = '[Filtered]';
      if (data.newPassword) data.newPassword = '[Filtered]';
      if (data.confirmPassword) data.confirmPassword = '[Filtered]';

      // Remove token fields
      if (data.token) data.token = '[Filtered]';
      if (data.refreshToken) data.refreshToken = '[Filtered]';

      // Remove payment fields
      if (data.pin) data.pin = '[Filtered]';
      if (data.walletPin) data.walletPin = '[Filtered]';
      if (data.cardNumber) data.cardNumber = '[Filtered]';
      if (data.cvv) data.cvv = '[Filtered]';
    }

    // Remove sensitive headers
    if (event.request?.headers) {
      const headers = event.request.headers;
      if (headers['authorization']) headers['authorization'] = '[Filtered]';
      if (headers['cookie']) headers['cookie'] = '[Filtered]';
      if (headers['x-api-key']) headers['x-api-key'] = '[Filtered]';
    }

    return event;
  },

  // Add custom context to all events
  beforeBreadcrumb: (breadcrumb: any) => {
    // Filter out noisy breadcrumbs
    if (breadcrumb.category === 'console' && breadcrumb.level === 'log') {
      return null;
    }
    return breadcrumb;
  },
};

/**
 * Check if Sentry is properly configured
 */
export const isSentryEnabled = (): boolean => {
  if (!sentryConfig.enabled) {
    console.warn('⚠️  Sentry is disabled. Set SENTRY_DSN to enable error tracking.');
    return false;
  }

  if (!sentryConfig.dsn) {
    console.warn('⚠️  Sentry DSN not configured. Error tracking is disabled.');
    return false;
  }

  console.log(`✅ Sentry enabled for environment: ${sentryConfig.environment}`);
  return true;
};
