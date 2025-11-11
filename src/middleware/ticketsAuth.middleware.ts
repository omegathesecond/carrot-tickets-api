import { Request, Response, NextFunction } from 'express';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Authenticate Tickets user (vendor or sub-user)
 * Verifies JWT token and attaches Tickets user to request
 */
export const authenticateTickets = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      ApiResponseUtil.unauthorized(res, 'No authorization header provided');
      return;
    }

    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      ApiResponseUtil.unauthorized(res, 'No token provided');
      return;
    }

    // Verify token
    const decoded = TicketsAuthService.verifyToken(token);

    // Attach Tickets user to request
    (req as any).ticketsUser = decoded;

    next();
  } catch (error: any) {
    ApiResponseUtil.unauthorized(res, error.message || 'Invalid or expired token');
  }
};

/**
 * Require specific Tickets permission
 * Checks if user has the required permission
 */
export const requireTicketsPermission = (permission: TicketsPermission) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ticketsUser = (req as any).ticketsUser;

    if (!ticketsUser) {
      ApiResponseUtil.unauthorized(res, 'Authentication required');
      return;
    }

    // Check permission in user's permission array
    const permissions = ticketsUser.permissions || [];
    if (!permissions.includes(permission)) {
      ApiResponseUtil.forbidden(res, `Permission required: ${permission}`);
      return;
    }

    next();
  };
};

/**
 * Require multiple Tickets permissions (all required)
 */
export const requireTicketsPermissions = (permissions: TicketsPermission[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ticketsUser = (req as any).ticketsUser;

    if (!ticketsUser) {
      ApiResponseUtil.unauthorized(res, 'Authentication required');
      return;
    }

    const userPermissions = ticketsUser.permissions || [];
    const hasAllPermissions = permissions.every(p => userPermissions.includes(p));

    if (!hasAllPermissions) {
      const missing = permissions.filter(p => !userPermissions.includes(p));
      ApiResponseUtil.forbidden(res, `Missing permissions: ${missing.join(', ')}`);
      return;
    }

    next();
  };
};

/**
 * Require ANY of the specified permissions
 */
export const requireAnyPermission = (permissions: TicketsPermission[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ticketsUser = (req as any).ticketsUser;

    if (!ticketsUser) {
      ApiResponseUtil.unauthorized(res, 'Authentication required');
      return;
    }

    const userPermissions = ticketsUser.permissions || [];
    const hasAnyPermission = permissions.some(p => userPermissions.includes(p));

    if (!hasAnyPermission) {
      ApiResponseUtil.forbidden(res, `One of these permissions required: ${permissions.join(', ')}`);
      return;
    }

    next();
  };
};

/**
 * Require vendor owner (not sub-user)
 */
export const requireTicketsOwner = (req: Request, res: Response, next: NextFunction): void => {
  const ticketsUser = (req as any).ticketsUser;

  if (!ticketsUser) {
    ApiResponseUtil.unauthorized(res, 'Authentication required');
    return;
  }

  if (ticketsUser.userType !== 'vendor') {
    ApiResponseUtil.forbidden(res, 'Only vendor owners can perform this action');
    return;
  }

  next();
};

/**
 * Attach Tickets user to request (optional - doesn't fail if no token)
 */
export const optionalTicketsAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      if (token) {
        const decoded = TicketsAuthService.verifyToken(token);
        (req as any).ticketsUser = decoded;
      }
    }

    next();
  } catch (error) {
    // Silent fail for optional auth
    next();
  }
};
