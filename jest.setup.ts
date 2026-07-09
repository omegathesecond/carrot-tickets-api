// Tests sign and verify JWTs throughout the suite; pin a deterministic
// secret before any module reads it. Production has NO fallback — see
// src/config/jwt.config.ts (fail-closed).
process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'test-secret-key';
