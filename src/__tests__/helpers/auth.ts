import { Vendor } from '@models/vendor.model';
import { VendorSubUser } from '@models/vendorSubUser.model';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { SubUserRole } from '@interfaces/subUser.interface';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Buyer } from '@models/buyer.model';
import { BuyerAuthService } from '@services/buyerAuth.service';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import mongoose from 'mongoose';

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

/** Mint a current persisted buyer session, including identity and auth version. */
export async function signBuyerSessionToken(phone: string): Promise<string> {
  const buyer = await Buyer.findOne({ phone });
  if (!buyer) throw new Error(`Missing buyer fixture: ${phone}`);
  return BuyerAuthService.signToken(buyer);
}

/** Sign an owner session against a persisted vendor, never trusting token permissions. */
export async function signVendorSessionToken(vendorId: string): Promise<string> {
  const vendor = await Vendor.findById(vendorId);
  if (!vendor) throw new Error(`Missing vendor fixture: ${vendorId}`);
  return jwt.sign({ app: 'tickets', userType: 'vendor', vendorId,
    authVersion: vendor.authVersion }, JWT_SECRET);
}

/** Restricted sessions must have persisted staff access, just like real logins. */
export async function signStaffSessionToken(vendorId: string, permissions: TicketsPermission[]): Promise<string> {
  const vendor = await Vendor.findById(vendorId);
  if (!vendor) throw new Error(`Missing vendor fixture: ${vendorId}`);
  const staff = await VendorSubUser.create({ vendorId, fullName: 'Test staff',
    password: 'secret123', role: SubUserRole.SCANNER });
  await TicketsUserAccess.create({ vendorId, userId: staff._id,
    role: TicketsRole.SCANNER, permissions });
  return jwt.sign({ app: 'tickets', userType: 'sub-user', vendorId,
    userId: String(staff._id), authVersion: staff.authVersion }, JWT_SECRET);
}

/** Create a platform administrator with a real account-backed owner session. */
export async function signAdminSessionToken(): Promise<string> {
  const admin = await Vendor.create({ businessName: 'Carrot admin',
    password: 'secret123', logoUrl: 'https://cdn.carrottickets.com/test/admin-logo.jpg', isSuperAdmin: true });
  return signVendorSessionToken(String(admin._id));
}

/** Seed a complete account-backed route fixture, including restricted staff access. */
export async function seedVendorSessionToken(
  fixtureId: string,
  options: { permissions?: TicketsPermission[] | string[]; isSuperAdmin?: boolean } = {},
): Promise<string> {
  const vendorId = mongoose.isValidObjectId(fixtureId)
    ? fixtureId : createHash('sha256').update(fixtureId).digest('hex').slice(0, 24);
  let vendor = await Vendor.findById(vendorId);
  if (!vendor) {
    vendor = await Vendor.create({ _id: vendorId, businessName: `Fixture ${fixtureId}`,
      password: 'secret123', logoUrl: 'https://cdn.carrottickets.com/test/logo.jpg',
      isSuperAdmin: options.isSuperAdmin === true });
  }
  if (options.isSuperAdmin === true && !vendor.isSuperAdmin) {
    throw new Error(`Fixture ${fixtureId} is not a platform administrator`);
  }
  if (options.permissions && !vendor.isSuperAdmin) {
    return signStaffSessionToken(vendorId, options.permissions as TicketsPermission[]);
  }
  return signVendorSessionToken(vendorId);
}
