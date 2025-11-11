/**
 * Database Configuration Utilities
 * Provides environment-aware database configuration and helper functions
 */

/**
 * Get the current environment
 */
export const getEnvironment = (): string => {
  return process.env['NODE_ENV'] || 'development';
};

/**
 * Check if running in production
 */
export const isProduction = (): boolean => {
  return getEnvironment() === 'production';
};

/**
 * Check if running in development
 */
export const isDevelopment = (): boolean => {
  return getEnvironment() === 'development';
};

/**
 * Extract database name from MongoDB URI
 */
export const getDatabaseName = (uri: string): string => {
  try {
    // MongoDB URI format: mongodb://host:port/database or mongodb+srv://host/database
    const match = uri.match(/\/([^/?]+)(\?|$)/);
    return match && match[1] ? match[1] : 'unknown';
  } catch (error) {
    return 'unknown';
  }
};

/**
 * Get database connection URI
 */
export const getDatabaseURI = (): string => {
  return process.env['MONGODB_URI'] || 'mongodb://localhost:27017/keshless-tickets-dev';
};

/**
 * Validate database configuration
 */
export const validateDatabaseConfig = (): {
  isValid: boolean;
  warnings: string[];
  errors: string[];
} => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const uri = getDatabaseURI();
  const dbName = getDatabaseName(uri);
  const env = getEnvironment();

  // Check if URI is set
  if (!process.env['MONGODB_URI']) {
    warnings.push('MONGODB_URI not set, using default local MongoDB');
  }

  // Production checks
  if (isProduction()) {
    // Warn if production is using dev database
    if (dbName.includes('dev') || dbName.includes('test')) {
      errors.push(`Production environment is using non-production database: "${dbName}"`);
    }

    // Warn if using local MongoDB in production
    if (uri.includes('localhost') || uri.includes('127.0.0.1')) {
      errors.push('Production environment is using local MongoDB - use MongoDB Atlas');
    }
  }

  // Development checks
  if (isDevelopment()) {
    // Warn if dev is using production database
    if (dbName === 'keshless-tickets' && !dbName.includes('dev')) {
      warnings.push(`Development environment appears to be using production database: "${dbName}"`);
      warnings.push('Consider using "keshless-tickets-dev" for development');
    }
  }

  return {
    isValid: errors.length === 0,
    warnings,
    errors
  };
};

/**
 * Get database connection info for logging
 */
export const getDatabaseInfo = (): {
  environment: string;
  databaseName: string;
  uri: string;
  isProduction: boolean;
} => {
  const uri = getDatabaseURI();

  return {
    environment: getEnvironment(),
    databaseName: getDatabaseName(uri),
    uri: uri.replace(/:[^:@]+@/, ':****@'), // Mask password in logs
    isProduction: isProduction()
  };
};

/**
 * Display database configuration on startup
 */
export const logDatabaseConfig = (): void => {
  const info = getDatabaseInfo();
  const validation = validateDatabaseConfig();

  console.log('');
  console.log('🎫 DATABASE CONFIGURATION - KESHLESS TICKETS');
  console.log('═'.repeat(50));
  console.log(`   Environment:     ${info.environment}`);
  console.log(`   Database:        ${info.databaseName}`);
  console.log(`   Connection:      ${info.uri}`);
  console.log(`   Production Mode: ${info.isProduction ? 'YES ⚠️' : 'NO'}`);

  // Show validation warnings
  if (validation.warnings.length > 0) {
    console.log('');
    console.log('⚠️  WARNINGS:');
    validation.warnings.forEach(warning => {
      console.log(`   • ${warning}`);
    });
  }

  // Show validation errors
  if (validation.errors.length > 0) {
    console.log('');
    console.log('❌ ERRORS:');
    validation.errors.forEach(error => {
      console.log(`   • ${error}`);
    });
  }

  console.log('═'.repeat(50));
  console.log('');
};

/**
 * Validate environment before proceeding
 * Throws error if critical validation fails
 */
export const validateEnvironment = (): void => {
  const validation = validateDatabaseConfig();

  if (!validation.isValid) {
    console.error('\n❌ DATABASE CONFIGURATION ERROR:\n');
    validation.errors.forEach(error => {
      console.error(`   • ${error}`);
    });
    console.error('\nPlease fix the configuration errors before starting the server.\n');
    throw new Error('Invalid database configuration');
  }
};
