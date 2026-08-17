import { Request, Response, NextFunction } from 'express';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { Vendor } from '@models/vendor.model';

/**
 * Machine-readable code carried in the 403 body's `error` field. The landing
 * client keys on this to pop the PhotoGate (see landing api.ts) instead of
 * showing a generic error toast.
 */
export const PHOTO_REQUIRED_CODE = 'PHOTO_REQUIRED';

/**
 * Server-side enforcement of the "add your photo" requirement on social writes.
 *
 * The client PhotoGate is only a UI wall — it blocks the social shell on the
 * landing site but does nothing for accounts acting through other clients, an
 * older bundle, or the gate-excluded event/checkout routes. This middleware is
 * the real invariant: a photoless actor cannot create a social footprint
 * (follow, post, comment, DM, meetup, community message…).
 *
 * It mirrors PhotoGate's logic exactly so client and server never disagree:
 *   - Buyer   → must have `avatarUrl`.
 *   - Brand owner (token carries EDIT_BRAND) → must have `logoUrl`.
 *   - Brand sub-user (SALES/SCANNER, no EDIT_BRAND) → EXEMPT. Their only way to
 *     satisfy the gate is the logo upload, which requires EDIT_BRAND and would
 *     403 — gating them would trap a staffer forever, so we let them through,
 *     the same carve-out the client makes.
 *   - No resolvable actor → pass through and let the route's own auth reject
 *     (keeps the optional-auth write routes behaving as before).
 *
 * Mount it AFTER the auth middleware that populates `req.ticketsUser`.
 *
 * Does NOT fail open: a lookup failure surfaces as a 500 (loud) rather than
 * silently letting a write through — that would defeat the whole point.
 */
export const requireProfilePhoto = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = (req as any).ticketsUser;
    if (!user) return next();

    // Brand actor — vendor owners and sub-users both carry vendorId.
    if (user.vendorId) {
      const canEditBrand = (user.permissions || []).includes(TicketsPermission.EDIT_BRAND);
      if (!canEditBrand) return next(); // exempt staffers who cannot upload a logo
      const vendor = await Vendor.findById(user.vendorId).select('logoUrl');
      if (vendor && !vendor.logoUrl) {
        ApiResponseUtil.error(res, 'Add a profile photo to continue', 403, PHOTO_REQUIRED_CODE);
        return;
      }
      return next();
    }

    // Buyer actor.
    if (user.userType === 'buyer' && (user.buyerId || user.userPhone)) {
      const buyer = await resolveBuyerFromRequest(req);
      if (buyer && !buyer.avatarUrl) {
        ApiResponseUtil.error(res, 'Add a profile photo to continue', 403, PHOTO_REQUIRED_CODE);
        return;
      }
      return next();
    }

    return next();
  } catch (error: any) {
    ApiResponseUtil.serverError(res, 'Could not verify your profile photo. Please try again.');
  }
};
