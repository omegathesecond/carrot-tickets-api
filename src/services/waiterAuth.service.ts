// api/src/services/waiterAuth.service.ts
import jwt, { SignOptions } from 'jsonwebtoken';
import { Waiter } from '@models/waiter.model';
import { Venue } from '@models/venue.model';
import { WaiterToken } from '@interfaces/waiter.interface';
import { deriveWaiterPermissions } from '@interfaces/operatorGrant.interface';
import { JWT_SECRET } from '@config/jwt.config';
import { normalizeLoginCode } from '@utils/operatorCredentials.util';
import { verifyOperatorPin } from '@utils/pinLockout.util';

const JWT_EXPIRY = process.env['JWT_EXPIRY'] || '7d';

/**
 * Waiter PIN-login + token issuance. A near-copy of CashierAuthService —
 * same lockout semantics, same "generic Invalid credentials on any failure"
 * discipline — issuing a waiter-scoped JWT instead of a cashier one.
 */
export class WaiterAuthService {
  static async login(loginCode: string, pin: string) {
    if (typeof loginCode !== 'string' || typeof pin !== 'string') {
      throw new Error('Invalid credentials');
    }
    const waiter = await Waiter.findOne({
      loginCode: normalizeLoginCode(loginCode), isActive: true,
    }).select('+pin');
    if (!waiter) throw new Error('Invalid credentials');

    // A venue's people are signed out with it. Checked BEFORE the lockout is
    // cleared, so a correct PIN at a suspended venue changes nothing.
    let venue: { name: string; currency: 'SZL' | 'ZAR'; status: string } | null = null;
    if (waiter.venueId) {
      venue = await Venue.findById(waiter.venueId).select('name currency status').lean<{ name: string; currency: 'SZL' | 'ZAR'; status: string } | null>();
      if (!venue || venue.status !== 'active') throw new Error('Venue trading is suspended');
    }

    await verifyOperatorPin(Waiter, waiter, pin);

    const isSuperAdmin = waiter.scope === 'platform';
    const permissions = deriveWaiterPermissions(waiter.grants);
    const payload: Record<string, unknown> = {
      scope: 'waiter',
      userType: 'waiter',
      waiterId: (waiter._id as any).toString(),
      role: 'waiter',
      // The POS's rendering copy only — authenticateWaiter re-derives this
      // from the row on every request, and THAT is what authorizes.
      permissions,
      isSuperAdmin,
      fullName: waiter.fullName,
    };
    if (!isSuperAdmin && waiter.vendorId) payload['vendorId'] = waiter.vendorId.toString();
    if (!isSuperAdmin && waiter.eventId) payload['eventId'] = waiter.eventId.toString();
    if (waiter.venueId) payload['venueId'] = waiter.venueId.toString();

    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    // Return the actor under `operator` to match the rest of the codebase's
    // /operator/login contract (gate/reseller/merchant/cashier all do), so
    // the POS client's `data['operator']` extraction works uniformly here too.
    return {
      accessToken,
      operator: {
        id: (waiter._id as any).toString(),
        fullName: waiter.fullName,
        scope: waiter.scope,
        eventId: waiter.eventId ? waiter.eventId.toString() : null,
        // A venue waiter's app has no event to load: the venue, its currency
        // and what this person may do come with the sign-in itself.
        ...(venue ? { venueId: waiter.venueId!.toString(), venueName: venue.name, currency: venue.currency, permissions } : {}),
      },
    };
  }

  /**
   * Verify a bearer token IS a waiter-scoped JWT, returning the typed payload.
   *
   * Whitelisted field by field rather than handed on whole, mirroring
   * CashierAuthService.verifyToken: everything downstream — the event scope
   * keyed off waiterId, and the staffName stamped onto a settlement's money
   * row — reads `req.waiter` as a WaiterToken, so anything a signer put in the
   * payload beyond this shape must not travel with it.
   */
  static verifyToken(token: string): WaiterToken {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.scope !== 'waiter') throw new Error('Not a waiter token');
    return {
      scope: 'waiter',
      userType: 'waiter',
      waiterId: decoded.waiterId,
      role: 'waiter',
      permissions: decoded.permissions || [],
      isSuperAdmin: !!decoded.isSuperAdmin,
      fullName: decoded.fullName,
      vendorId: decoded.vendorId,
      eventId: decoded.eventId,
      venueId: decoded.venueId,
    };
  }
}
