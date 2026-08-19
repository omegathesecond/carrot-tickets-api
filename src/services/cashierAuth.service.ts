// api/src/services/cashierAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Cashier } from '@models/cashier.model';
import { CASHIER_PERMISSIONS, CashierToken } from '@interfaces/cashier.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/**
 * Cashier PIN-login + token issuance. A near-copy of GateOperatorAuthService —
 * same lockout semantics, same "generic Invalid credentials on any failure"
 * discipline — issuing a cashier-scoped JWT instead of a gate one.
 */
export class CashierAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const cashier = await Cashier.findOne({ loginCode: normalizeLoginCode(loginCode), isActive: true }).select('+pin');
    if (!cashier) throw new Error('Invalid credentials');

    if (cashier.lockedUntil && cashier.lockedUntil.getTime() > Date.now()) {
      throw new Error('Account locked. Try again later.');
    }

    const ok = await cashier.comparePin(pin);
    if (!ok) {
      cashier.failedPinAttempts = (cashier.failedPinAttempts ?? 0) + 1;
      if (cashier.failedPinAttempts >= MAX_PIN_ATTEMPTS) {
        cashier.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        cashier.failedPinAttempts = 0;
      }
      await cashier.save();
      throw new Error('Invalid credentials');
    }

    cashier.failedPinAttempts = 0;
    cashier.lockedUntil = null;
    cashier.lastLoginAt = new Date();
    await cashier.save();

    const isSuperAdmin = cashier.scope === 'platform';
    const payload: Record<string, unknown> = {
      scope: 'cashier',
      userType: 'cashier',
      cashierId: (cashier._id as any).toString(),
      role: 'cashier',
      permissions: CASHIER_PERMISSIONS,
      isSuperAdmin,
      fullName: cashier.fullName,
    };
    if (!isSuperAdmin && cashier.vendorId) payload['vendorId'] = cashier.vendorId.toString();
    if (!isSuperAdmin && cashier.eventId) payload['eventId'] = cashier.eventId.toString();

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    // Return the actor under `operator` to match the rest of the codebase's
    // /operator/login contract (gate/reseller/merchant all do), so the POS
    // client's `data['operator']` extraction works uniformly for cashiers too.
    return {
      accessToken,
      operator: {
        id: (cashier._id as any).toString(),
        fullName: cashier.fullName,
        scope: cashier.scope,
        vendorId: cashier.vendorId ? cashier.vendorId.toString() : null,
      },
    };
  }

  /** Verify a bearer token IS a cashier-scoped JWT, returning the typed payload. */
  static verifyToken(token: string): CashierToken {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.scope !== 'cashier') throw new Error('Not a cashier token');
    return {
      scope: 'cashier',
      cashierId: decoded.cashierId,
      vendorId: decoded.vendorId,
      eventId: decoded.eventId,
      isSuperAdmin: !!decoded.isSuperAdmin,
      fullName: decoded.fullName,
      permissions: decoded.permissions || [],
    };
  }
}
