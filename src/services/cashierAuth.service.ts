// api/src/services/cashierAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Cashier } from '@models/cashier.model';
import { CASHIER_PERMISSIONS, CashierToken } from '@interfaces/cashier.interface';
import { grantedCashierPermissions } from '@interfaces/operatorGrant.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { recordFailedPinAttempt, clearPinLockout } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

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
      // Counted on the server, not on this loaded document — N guesses in
      // flight together must reach N and lock, not all write 1.
      await recordFailedPinAttempt(Cashier, cashier._id as any);
      throw new Error('Invalid credentials');
    }

    await clearPinLockout(Cashier, cashier._id as any);

    const isSuperAdmin = cashier.scope === 'platform';
    const payload: Record<string, unknown> = {
      scope: 'cashier',
      userType: 'cashier',
      cashierId: (cashier._id as any).toString(),
      role: 'cashier',
      // Role set is the floor; per-person grants (e.g. the tag desk) add to it.
      permissions: [...CASHIER_PERMISSIONS, ...grantedCashierPermissions((cashier as any).grants)],
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
