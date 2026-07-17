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
 * Authenticate a buyer (ticket holder) on the public site.
 *
 * Buyer tokens carry { app: 'tickets', userType: 'buyer', userPhone } and are
 * verified with the same secret as vendor tokens. We require userType to be
 * 'buyer' here so a vendor/sub-user token can't be used to hit buyer routes
 * (and vice-versa — buyer tokens carry no permissions, so they can't reach the
 * permission-gated vendor endpoints).
 */
export const authenticateBuyer = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      ApiResponseUtil.unauthorized(res, 'Please sign in to view your tickets');
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      ApiResponseUtil.unauthorized(res, 'No token provided');
      return;
    }

    const decoded = TicketsAuthService.verifyToken(token);
    if ((decoded as any).userType !== 'buyer' || !(decoded as any).userPhone) {
      ApiResponseUtil.unauthorized(res, 'Invalid buyer token');
      return;
    }

    (req as any).ticketsUser = decoded;
    next();
  } catch (error: any) {
    ApiResponseUtil.unauthorized(res, error.message || 'Invalid or expired token');
  }
};

/**
 * Authenticate a Community VIEWER — a buyer (ticket holder / attendee) OR an
 * organizer (vendor / sub-user) whose token manages the event. Both token
 * kinds are attached as `ticketsUser`; the read controllers/services branch on
 * userType (see organizerFromRequest). Buyers get the full member experience;
 * organizers get a read-only peek of events they own.
 *
 * Only the READ community routes use this. Write routes (join, send, mark-read,
 * verify-ticket, delete, reports) stay on authenticateBuyer, so an organizer
 * token structurally can't post or mutate — read-only falls out of the routing.
 */
export const authenticateCommunityViewer = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      ApiResponseUtil.unauthorized(res, 'Please sign in to view the community');
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      ApiResponseUtil.unauthorized(res, 'No token provided');
      return;
    }

    const decoded = TicketsAuthService.verifyToken(token) as any;
    const isBuyer = decoded.userType === 'buyer' && decoded.userPhone;
    const isOrganizer =
      (decoded.userType === 'vendor' || decoded.userType === 'sub-user') && decoded.vendorId;
    if (!isBuyer && !isOrganizer) {
      ApiResponseUtil.unauthorized(res, 'Invalid token');
      return;
    }

    (req as any).ticketsUser = decoded;
    next();
  } catch (error: any) {
    ApiResponseUtil.unauthorized(res, error.message || 'Invalid or expired token');
  }
};

/**
 * Require super-admin access.
 * Checks isSuperAdmin flag on the already-decoded ticketsUser.
 * Must be used after authenticateTickets.
 */
export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!(req as any).ticketsUser?.isSuperAdmin) {
    ApiResponseUtil.forbidden(res, 'Super admin access required');
    return;
  }
  next();
};

/**
 * Allow either super-admins OR holders of a specific permission.
 * requireTicketsPermission alone does not bypass for super-admins, so admin
 * views that should also be openable by an explicitly-permissioned team member
 * (e.g. VIEW_USERS) use this.
 */
export const requireSuperAdminOrPermission = (permission: TicketsPermission) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ticketsUser = (req as any).ticketsUser;
    if (!ticketsUser) {
      ApiResponseUtil.unauthorized(res, 'Authentication required');
      return;
    }
    if (ticketsUser.isSuperAdmin || (ticketsUser.permissions || []).includes(permission)) {
      next();
      return;
    }
    ApiResponseUtil.forbidden(res, `Permission required: ${permission}`);
  };
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
