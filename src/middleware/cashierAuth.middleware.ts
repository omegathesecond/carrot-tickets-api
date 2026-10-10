// api/src/middleware/cashierAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { CashierAuthService } from '@services/cashierAuth.service';
import { CashierPermission } from '@interfaces/cashier.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadCashierForRequest } from '@services/operatorEventScope.service';
import { deriveCashierPermissions } from '@interfaces/operatorGrant.interface';

/** Mirrors authenticateMerchant — verifies the bearer token is a cashier-scoped JWT. */
export const authenticateCashier = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  let decoded;
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    decoded = CashierAuthService.verifyToken(token); // throws if scope !== 'cashier'
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
    return;
  }
  try {
    const cashier = await loadCashierForRequest(req, decoded.cashierId);
    if (!cashier?.isActive) { ApiResponseUtil.forbidden(res, 'Cashier account is inactive'); return; }
    (req as any).cashier = {...decoded, permissions: deriveCashierPermissions(cashier.grants),
      isSuperAdmin: cashier.scope === 'platform', vendorId: cashier.vendorId?.toString(),
      eventId: cashier.eventId?.toString(), fullName: cashier.fullName};
    next();
  } catch (error) { next(error); }
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
