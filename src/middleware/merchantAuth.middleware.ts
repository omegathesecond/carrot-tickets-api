// api/src/middleware/merchantAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { MerchantAuthService } from '@services/merchantAuth.service';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/** Mirrors authenticateReseller — verifies the bearer token is a merchant-scoped JWT. */
export const authenticateMerchant = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    const decoded = MerchantAuthService.verifyToken(token); // throws if scope !== 'merchant'
    // Every charge must name the PERSON who took it. A token minted before
    // per-person operators names only the stall, so it is rejected outright
    // rather than allowed through as an unattributable charge.
    if (!decoded.merchantOperatorId) {
      ApiResponseUtil.unauthorized(res, 'Token predates per-person operators — sign in again');
      return;
    }
    (req as any).merchant = decoded;
    next();
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
  }
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
