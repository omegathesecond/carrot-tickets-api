// api/src/middleware/waiterAuth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
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
    const decoded = jwt.verify(token, JWT_SECRET) as { scope?: string };
    if (decoded.scope !== 'waiter') throw new Error('Invalid or expired token');
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
