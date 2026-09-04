// api/src/middleware/merchantAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { MerchantAuthService } from '@services/merchantAuth.service';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantPermission, MerchantToken } from '@interfaces/merchant.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Mirrors authenticateReseller — verifies the bearer token is a merchant-scoped
 * JWT — and then re-reads the PERSON and the STALL it names.
 *
 * The liveness check lives here rather than in the handlers because merchant
 * tokens live 7 days and PATCH /merchant-operators/:id {isActive:false} (or
 * suspending the stall) is the only revocation the dashboard offers. Only
 * MerchantService.charge used to re-read the rows, so a sacked operator kept
 * reading the stall's takings, its stock board and posting stock counts until
 * their token expired. Two findById reads on indexed _ids per request cover
 * every merchant route at once and cannot be forgotten by the next handler.
 */
export const authenticateMerchant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  let decoded: MerchantToken;
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    decoded = MerchantAuthService.verifyToken(token); // throws if scope !== 'merchant'
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
    return;
  }

  // Every charge must name the PERSON who took it. A token minted before
  // per-person operators names only the stall, so it is rejected outright
  // rather than allowed through as an unattributable charge.
  if (!decoded.merchantOperatorId) {
    ApiResponseUtil.unauthorized(res, 'Token predates per-person operators — sign in again');
    return;
  }

  // A database failure is NOT swallowed into a 401 — it goes to the error
  // handler as a 500, so an outage reads as an outage rather than "signed out".
  let operator: { isActive?: boolean } | null;
  let merchant: { status?: string } | null;
  try {
    [operator, merchant] = await Promise.all([
      MerchantOperator.findById(decoded.merchantOperatorId).select('isActive').lean<{ isActive?: boolean } | null>(),
      Merchant.findById(decoded.merchantId).select('status').lean<{ status?: string } | null>(),
    ]);
  } catch (e) {
    next(e);
    return;
  }

  // A row that no longer exists is refused the same way as a revoked one: a
  // deleted person or stall must not keep working because nothing says no.
  if (!operator || !operator.isActive) { ApiResponseUtil.unauthorized(res, 'Operator deactivated'); return; }
  if (!merchant || merchant.status !== 'active') { ApiResponseUtil.unauthorized(res, 'Merchant suspended'); return; }

  (req as any).merchant = decoded;
  next();
};

export const requireMerchantPermission = (permission: MerchantPermission) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const merchant = (req as any).merchant;
    if (!merchant) { ApiResponseUtil.unauthorized(res, 'Authentication required'); return; }
    if (!(merchant.permissions || []).includes(permission)) {
      ApiResponseUtil.forbidden(res, `Permission required: ${permission}`); return;
    }
    next();
  };
