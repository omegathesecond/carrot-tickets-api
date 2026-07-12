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

/**
 * Signs a buyer JWT matching the shape BuyerAuthService mints
 * ({ app, userType: 'buyer', userPhone }) for authenticateBuyer routes.
 */
export function signBuyerToken(phone: string): string {
  return jwt.sign({ app: 'tickets', userType: 'buyer', userPhone: phone }, JWT_SECRET);
}

/**
 * Signs a vendor JWT for a specific vendorId (payload shape matches what
 * TicketsAuthService mints for real vendor logins). Unlike
 * signSuperAdminToken()'s fixed 'admin-vendor-id' (a placeholder string,
 * not a valid Mongo ObjectId), callers that need to persist/read an Update
 * (or any authorId: ObjectId field) authored by this vendor should pass a
 * real ObjectId string here.
 */
export function signVendorToken(vendorId: string, extra: Record<string, unknown> = {}): string {
  return jwt.sign(
    { app: 'tickets', userType: 'vendor', vendorId, isSuperAdmin: false, role: 'owner', permissions: [], ...extra },
    JWT_SECRET,
  );
}
