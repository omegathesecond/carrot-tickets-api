/**
 * Single source of truth for the tickets JWT secret.
 *
 * FAIL-CLOSED: if JWT_SECRET is missing the process must not boot. Every
 * token this API mints (vendor, buyer, reseller, gate operator — and soon
 * chat sockets) is signed with this secret; a fallback default would let
 * anyone forge any identity.
 */
const secret = process.env['JWT_SECRET'];

if (!secret || secret.trim().length === 0) {
  throw new Error(
    'FATAL: JWT_SECRET is not set. Refusing to start — configure the JWT_SECRET env var on the service.'
  );
}

export const JWT_SECRET: string = secret;
