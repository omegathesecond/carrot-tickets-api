// api/src/middleware/waiterAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { WaiterAuthService } from '@services/waiterAuth.service';
import { Waiter } from '@models/waiter.model';
import { Venue } from '@models/venue.model';
import { WaiterPermission, WaiterToken } from '@interfaces/waiter.interface';
import { deriveWaiterPermissions } from '@interfaces/operatorGrant.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Mirrors authenticateMerchant — verifies the bearer token is a waiter-scoped
 * JWT, then re-reads the PERSON it names.
 *
 * A cashier's (or any other actor's) token reaching a waiter route is a
 * privilege bug, not just a missing permission, so scope is checked here
 * rather than left to requireWaiterPermission below.
 *
 * The row read is what makes a grant change take effect. A waiter token lives
 * 7 days and carries its `permissions` claim frozen at login, so "Settling
 * on" flipped in the dashboard reached nothing until the waiter next signed
 * in — the organizer saw the toggle move and the handheld carry on refusing.
 * The same read fails closed on a fired or deleted waiter, the way
 * `waiterScope` already does for event assignment.
 */
export const authenticateWaiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  let decoded: WaiterToken;
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    // Through the service, not jwt.verify here: a raw decoded payload is
    // whatever the signer put in it, and req.waiter is read downstream as a
    // WaiterToken — by the event-scope resolver and by the settlement that
    // stamps staffName onto a money row. verifyToken narrows it to the
    // declared shape before either sees it.
    decoded = WaiterAuthService.verifyToken(token); // throws if scope !== 'waiter'
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
    return;
  }

  // A database failure is NOT swallowed into a 401 — it goes to the error
  // handler as a 500, so an outage reads as an outage rather than "signed out".
  let waiter: { isActive?: boolean; grants?: string[] } | null;
  let venue: { _id: unknown; name: string; currency: string; vendorId: unknown; status: string } | null = null;
  try {
    [waiter, venue] = await Promise.all([
      Waiter.findById(decoded.waiterId)
        .select('isActive grants')
        .lean<{ isActive?: boolean; grants?: string[] } | null>(),
      // An event token adds no read.
      decoded.venueId
        ? Venue.findById(decoded.venueId).select('name currency vendorId status').lean<{ _id: unknown; name: string; currency: string; vendorId: unknown; status: string } | null>()
        : Promise.resolve(null),
    ]);
  } catch (e) {
    next(e);
    return;
  }

  // A row that no longer exists is refused the same way as a revoked one: a
  // deleted person must not keep working because nothing says no.
  if (!waiter || !waiter.isActive) { ApiResponseUtil.unauthorized(res, 'Operator deactivated'); return; }
  // Suspending a venue signs its waiters out on their next request — the
  // token alone (7 days) would otherwise keep them trading.
  if (decoded.venueId && (!venue || venue.status !== 'active')) {
    ApiResponseUtil.unauthorized(res, 'Venue trading is suspended'); return;
  }

  // The token's own `permissions` is the POS's copy for rendering; it is NEVER
  // what authorizes. The row is already in hand from the liveness read above,
  // so deriving here costs no extra query.
  (req as any).waiter = { ...decoded, permissions: deriveWaiterPermissions(waiter.grants) };
  if (venue) (req as any).waiterVenue = venue;
  next();
};

export const requireWaiterPermission = (permission: WaiterPermission) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const waiter = (req as any).waiter;
    if (!waiter) { ApiResponseUtil.unauthorized(res, 'Authentication required'); return; }
    if (!(waiter.permissions || []).includes(permission)) {
      ApiResponseUtil.forbidden(res, `Permission required: ${permission}`); return;
    }
    next();
  };
