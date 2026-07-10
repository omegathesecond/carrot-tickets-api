// Tests sign and verify JWTs throughout the suite; pin a deterministic
// secret before any module reads it. Production has NO fallback — see
// src/config/jwt.config.ts (fail-closed).
process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'test-secret-key';

// Web Push (VAPID) config is read at import time by src/config/vapid.config.ts.
// Set deterministic test values so vapidConfigured evaluates true in the
// suite — unlike JWT, missing VAPID env in production must NOT crash the
// boot (see vapid.config.ts), so this is purely a test-fixture concern.
process.env['VAPID_PUBLIC_KEY'] = process.env['VAPID_PUBLIC_KEY'] || 'test-vapid-public';
process.env['VAPID_PRIVATE_KEY'] = process.env['VAPID_PRIVATE_KEY'] || 'test-vapid-private';
process.env['VAPID_SUBJECT'] = process.env['VAPID_SUBJECT'] || 'mailto:test@example.com';
