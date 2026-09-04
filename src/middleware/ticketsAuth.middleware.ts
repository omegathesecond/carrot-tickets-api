import { Request, Response, NextFunction } from 'express';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { gateOperatorPermissions } from '@services/gateOperatorAuth.service';
import { GateOperator } from '@models/gateOperator.model';
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
 * The permission set a request is checked against.
 *
 * Organizer / vendor / sub-user tokens are checked on the TOKEN, as before.
 *
 * A GATE OPERATOR token is not. Its `permissions` array is the SCANNER role
 * set plus the per-person grants (e.g. issue_tags, which gates bind-band and
 * the tag registry) as they stood at login — and the token then lives 7 days.
 * An organizer removing a grant through PATCH /gate-operators/:id {grants:[]}
 * therefore changed nothing until the person next logged in: verified live,
 * the old token still passed the ISSUE_TAGS gate. So for a gate operator the
 * set is re-resolved from the row on every request (one findById on an
 * indexed _id), through the same function login mints it with, and a row that
 * is missing or deactivated yields null → the request is refused outright.
 *
 * A database failure propagates rather than resolving to "no permissions" or
 * "the token's permissions" — an outage must read as a 500, not as a silent
 * narrowing or widening.
 */
async function effectivePermissions(ticketsUser: any): Promise<string[] | null> {
  if (ticketsUser.userType !== 'gate-operator') return ticketsUser.permissions || [];

  // Every gate token names its row; one that does not is refused rather than
  // trusted on its own say-so.
  if (!ticketsUser.userId) return null;
  const row = await GateOperator.findById(String(ticketsUser.userId))
    .select('isActive grants')
    .lean<{ isActive?: boolean; grants?: string[] } | null>();
  if (!row || !row.isActive) return null;
  return gateOperatorPermissions(row.grants);
}

/** Shared prologue for the permission and super-admin gates below. */
async function resolvePermissions(req: Request, res: Response, next: NextFunction): Promise<string[] | undefined> {
  const ticketsUser = (req as any).ticketsUser;
  if (!ticketsUser) {
    ApiResponseUtil.unauthorized(res, 'Authentication required');
    return undefined;
  }

  let permissions: string[] | null;
  try {
    permissions = await effectivePermissions(ticketsUser);
  } catch (e) {
    next(e);
    return undefined;
  }

  if (permissions === null) {
    ApiResponseUtil.unauthorized(res, 'Operator deactivated');
    return undefined;
  }
  return permissions;
}

/**
 * Require specific Tickets permission
 * Checks if user has the required permission
 */
export const requireTicketsPermission = (permission: TicketsPermission) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const permissions = await resolvePermissions(req, res, next);
    if (!permissions) return;

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
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userPermissions = await resolvePermissions(req, res, next);
    if (!userPermissions) return;

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
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userPermissions = await resolvePermissions(req, res, next);
    if (!userPermissions) return;

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
 * Buyer tokens carry { app, userType:'buyer', buyerId?, userPhone?, userEmail? }
 * and are verified with the same secret as vendor tokens. buyerId is the
 * canonical identity (email-only buyers always carry it); phone tokens
 * without a buyerId fall back to userPhone — resolveBuyerFromRequest mirrors
 * this precedence. We require userType to be 'buyer' here so a vendor/sub-user
 * token can't be used to hit buyer routes (and vice-versa — buyer tokens carry
 * no permissions, so they can't reach the permission-gated vendor endpoints).
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
    if ((decoded as any).userType !== 'buyer' || !((decoded as any).buyerId || (decoded as any).userPhone)) {
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
    const isBuyer = decoded.userType === 'buyer' && (decoded.buyerId || decoded.userPhone);
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
 * Dual-actor auth for WRITE routes open to both a buyer and an organizer
 * (vendor / sub-user) — e.g. reviewing a services business, where a customer OR
 * a fellow organizer may post. Both token kinds are attached as `ticketsUser`;
 * unlike authenticateCommunityViewer (deliberately read-only for organizers)
 * the controller/service here is responsible for gating what each actor may do
 * (buyers keep the enquiry gate; an organizer can't review its own business).
 */
export const authenticateBuyerOrOrganizer = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      ApiResponseUtil.unauthorized(res, 'Please sign in first');
      return;
    }
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      ApiResponseUtil.unauthorized(res, 'No token provided');
      return;
    }
    const decoded = TicketsAuthService.verifyToken(token) as any;
    const isBuyer = decoded.userType === 'buyer' && (decoded.buyerId || decoded.userPhone);
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
 * Like authenticateCommunityViewer, but NEVER rejects an anonymous request:
 * a valid buyer/organizer token still populates `req.ticketsUser` (so the
 * viewer gets their membership state), while a missing/invalid token falls
 * through as anonymous (`ticketsUser` stays undefined). Used only on the public
 * social-proof reads — who's-going roster + community view — so signed-out
 * visitors can see who's going. Write/message routes stay on the strict
 * middleware above.
 */
export const optionalCommunityViewer = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');
  if (token) {
    try {
      const decoded = TicketsAuthService.verifyToken(token) as any;
      const isBuyer = decoded.userType === 'buyer' && (decoded.buyerId || decoded.userPhone);
      const isOrganizer =
        (decoded.userType === 'vendor' || decoded.userType === 'sub-user') && decoded.vendorId;
      if (isBuyer || isOrganizer) (req as any).ticketsUser = decoded;
    } catch {
      // Invalid/expired token on a public read → treat as anonymous, don't 401.
    }
  }
  next();
};

/**
 * Require super-admin access. Must be used after authenticateTickets.
 *
 * A dashboard super-admin is checked on the TOKEN flag, as before. A PLATFORM
 * gate operator's token carries isSuperAdmin: true as well (minted from its
 * scope at login), and honouring that flag alone meant deactivating the person
 * changed nothing here until the token expired, up to 7 days later. So for a
 * gate-operator token the row is read through the same prologue the permission
 * gates use, and a missing or deactivated row is refused with the same 401
 * before the flag is honoured. For every other token kind the prologue reads
 * nothing.
 */
export const requireSuperAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!(req as any).ticketsUser?.isSuperAdmin) {
    ApiResponseUtil.forbidden(res, 'Super admin access required');
    return;
  }
  if (!(await resolvePermissions(req, res, next))) return;
  next();
};

/**
 * Allow either super-admins OR holders of a specific permission.
 * requireTicketsPermission alone does not bypass for super-admins, so admin
 * views that should also be openable by an explicitly-permissioned team member
 * (e.g. VIEW_USERS) use this.
 */
export const requireSuperAdminOrPermission = (permission: TicketsPermission) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Row-resolved for a gate operator (liveness + current grants), token-
    // resolved for everyone else — see requireSuperAdmin and effectivePermissions.
    const permissions = await resolvePermissions(req, res, next);
    if (!permissions) return;

    if ((req as any).ticketsUser.isSuperAdmin || permissions.includes(permission)) {
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
