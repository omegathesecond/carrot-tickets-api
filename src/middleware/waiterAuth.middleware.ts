// api/src/middleware/waiterAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { WaiterAuthService } from '@services/waiterAuth.service';
import { WaiterPermission } from '@interfaces/waiter.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Mirrors authenticateCashier — verifies the bearer token is a waiter-scoped
 * JWT. A cashier (or any other actor's) token reaching a waiter route is a
 * privilege bug, not just a missing permission, so scope is checked here
 * rather than left to requireWaiterPermission below.
 */
export const authenticateWaiter = (req: Request, res: Response, next: NextFunction): void => {
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
    const decoded = WaiterAuthService.verifyToken(token); // throws if scope !== 'waiter'
    (req as any).waiter = decoded;
    next();
  } catch (e: any) {
    ApiResponseUtil.unauthorized(res, e.message || 'Invalid or expired token');
  }
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
