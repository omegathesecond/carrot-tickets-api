/**
 * Jest global setup — runs before any test module is imported.
 *
 * Sets a deterministic, obviously-fake JWT secret on the environment so that:
 *   1. The strict secret loader (src/config/secrets.config.ts) finds a value and
 *      does not throw at import time.
 *   2. App code and the test auth helpers (which read process.env['JWT_SECRET'])
 *      sign and verify with the SAME secret.
 *
 * This value is never used outside the test suite.
 */
process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'test-jwt-secret-not-for-production';
