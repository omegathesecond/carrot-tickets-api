// api/src/services/merchantAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Merchant } from '@models/merchant.model';
import { Event } from '@models/event.model';
import { MerchantPermission, MerchantToken } from '@interfaces/merchant.interface';
import { JWT_SECRET } from '@config/jwt.config';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/**
 * Merchant login — loginCode + PIN, mirroring GateOperatorAuthService /
 * ResellerAuthService exactly (bcrypt compare via comparePin, same lockout
 * bookkeeping, same JWT_SECRET). A merchant token is scoped to ONE event
 * (Merchant.eventId) and carries a single fixed permission
 * (merchant:charge) — there is no role/permission matrix to look up, unlike
 * reseller.
 */
export class MerchantAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const merchant = await Merchant.findOne({ loginCode, status: 'active' }).select('+pin');
    if (!merchant) throw new Error('Invalid credentials');

    if (merchant.lockedUntil && merchant.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await merchant.comparePin(pin);
    if (!ok) {
      merchant.failedPinAttempts = (merchant.failedPinAttempts ?? 0) + 1;
      if (merchant.failedPinAttempts >= MAX_PIN_ATTEMPTS) {
        merchant.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        merchant.failedPinAttempts = 0;
      }
      await merchant.save();
      throw new Error('Invalid credentials');
    }

    merchant.failedPinAttempts = 0;
    merchant.lockedUntil = null;
    merchant.lastLoginAt = new Date();
    await merchant.save();

    // The app's vendor header shows this instead of a raw eventId — best
    // effort: a missing/deleted event must not block login, it just means
    // eventName comes back undefined and the UI falls back to the id.
    const event = await Event.findById(merchant.eventId).select('name').lean();

    const payload: MerchantToken = {
      scope: 'merchant',
      merchantId: (merchant._id as any).toString(),
      eventId: merchant.eventId.toString(),
      name: merchant.name,
      ...(event?.name ? { eventName: event.name } : {}),
      permissions: [MerchantPermission.CHARGE],
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    return {
      accessToken,
      operator: {
        merchantId: payload.merchantId,
        name: merchant.name,
        eventId: payload.eventId,
        eventName: event?.name,
      },
    };
  }

  static verifyToken(token: string): MerchantToken {
    const decoded = jwt.verify(token, JWT_SECRET) as MerchantToken;
    if (decoded.scope !== 'merchant') throw new Error('Invalid token scope');
    return decoded;
  }
}
