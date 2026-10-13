import { Request, Response, NextFunction } from 'express';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { ResellerPermission } from '@interfaces/resellerPermission.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Reseller } from '@models/reseller.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { RESELLER_ROLE_PERMISSIONS, ResellerRole } from '@interfaces/resellerPermission.interface';

export const authenticateReseller = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  let decoded;
  try {
    const header = req.headers.authorization;
    if (!header) { ApiResponseUtil.unauthorized(res, 'No authorization header provided'); return; }
    const token = header.replace('Bearer ', '');
    if (!token) { ApiResponseUtil.unauthorized(res, 'No token provided'); return; }
    decoded = ResellerAuthService.verifyToken(token);
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
    return;
  }
  try {
    const company = await Reseller.findById(decoded.resellerId).select('isActive status');
    if (!company?.isActive || company.status !== 'active') { ApiResponseUtil.unauthorized(res, 'Reseller account is inactive'); return; }
    const isOwner = decoded.operatorId === decoded.resellerId;
    if (!isOwner) {
      const operator = await ResellerOperator.findById(decoded.operatorId).select('isActive resellerId hubId role');
      if (!operator?.isActive || String(operator.resellerId) !== decoded.resellerId) { ApiResponseUtil.unauthorized(res, 'Operator account is inactive'); return; }
      if (!RESELLER_ROLE_PERMISSIONS[operator.role as ResellerRole]) { ApiResponseUtil.unauthorized(res, 'Invalid operator role'); return; }
      decoded = { ...decoded, role: operator.role as ResellerRole, hubId: operator.hubId ? String(operator.hubId) : null,
        permissions: RESELLER_ROLE_PERMISSIONS[operator.role as ResellerRole] };
    } else {
      decoded = { ...decoded, role: ResellerRole.ADMIN, permissions: RESELLER_ROLE_PERMISSIONS[ResellerRole.ADMIN] };
    }
    (req as any).reseller = decoded;
    next();
  } catch (error) { next(error); }
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
