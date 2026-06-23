import { Request, Response, NextFunction } from 'express';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

export const authenticateReseller = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    const decoded = ResellerAuthService.verifyToken(token); // throws if scope !== 'reseller'
    (req as any).reseller = decoded;
    next();
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
  }
};

export const requireResellerPermission = (permission: ResellerPermission) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const reseller = (req as any).reseller;
    if (!reseller) { ApiResponseUtil.unauthorized(res, 'Authentication required'); return; }
    if (!(reseller.permissions || []).includes(permission)) {
      ApiResponseUtil.forbidden(res, `Permission required: ${permission}`); return;
    }
    next();
  };
