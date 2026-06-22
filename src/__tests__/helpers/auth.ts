import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

/**
 * Signs a super-admin vendor JWT for use in tests.
 * Payload matches the tickets token shape expected by authenticateTickets.
 */
export function signSuperAdminToken(): string {
  return jwt.sign(
    {
      app: 'tickets',
      vendorId: 'admin-vendor-id',
      userType: 'vendor',
      isSuperAdmin: true,
      role: 'owner',
      permissions: [],
    },
    JWT_SECRET,
  );
}
