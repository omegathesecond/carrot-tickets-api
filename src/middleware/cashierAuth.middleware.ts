// api/src/middleware/cashierAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { CashierAuthService } from '@services/cashierAuth.service';
import { CashierPermission } from '@interfaces/cashier.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/** Mirrors authenticateMerchant — verifies the bearer token is a cashier-scoped JWT. */
export const authenticateCashier = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    const decoded = CashierAuthService.verifyToken(token); // throws if scope !== 'cashier'
    (req as any).cashier = decoded;
    next();
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
  }
};

export const requireCashierPermission = (permission: CashierPermission) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const cashier = (req as any).cashier;
    if (!cashier) { ApiResponseUtil.unauthorized(res, 'Authentication required'); return; }
    if (!(cashier.permissions || []).includes(permission)) {
      ApiResponseUtil.forbidden(res, `Permission required: ${permission}`); return;
    }
    next();
  };
