import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Constant-time string comparison. Avoids leaking how many leading characters of
 * the shared service key an attacker has guessed via response-timing differences.
 * Returns false on any length mismatch (timingSafeEqual requires equal lengths).
 */
const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Service-to-Service Authentication Middleware
 *
 * This middleware authenticates requests from the main Keshless API
 * using a shared service key, bypassing the need for individual user JWT tokens.
 *
 * Headers required:
 * - x-service-key: Shared secret key for service authentication
 * - x-user-id: ID of the user making the request (passed from main API)
 * - x-user-type: Type of user ('user' or 'vendor')
 */
export const serviceAuth = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const serviceKey = req.headers['x-service-key'] as string;
    const userId = req.headers['x-user-id'] as string;
    const userType = req.headers['x-user-type'] as string;
    const userPhone = req.headers['x-user-phone'] as string | undefined;

    // Validate service key
    const expectedServiceKey = process.env.SERVICE_KEY;

    if (!expectedServiceKey || expectedServiceKey === '') {
      console.error('[Service Auth] SERVICE_KEY not configured in environment');
      ApiResponseUtil.error(res, 'Service authentication not configured', 500);
      return;
    }

    if (!serviceKey) {
      ApiResponseUtil.unauthorized(res, 'Service key required');
      return;
    }

    if (!safeEqual(serviceKey, expectedServiceKey)) {
      console.warn('[Service Auth] Invalid service key attempted');
      ApiResponseUtil.unauthorized(res, 'Invalid service key');
      return;
    }

    // Validate user context
    if (!userId) {
      ApiResponseUtil.error(res, 'User ID required for service requests', 400);
      return;
    }

    if (!userType || !['user', 'vendor'].includes(userType)) {
      ApiResponseUtil.error(res, 'Valid user type required (user or vendor)', 400);
      return;
    }

    // Attach user context to request (compatible with existing auth structure)
    (req as any).ticketsUser = {
      userId,
      userType,
      userPhone, // forwarded by the main keshless-api proxy from req.user.phoneNumber
      authenticatedVia: 'service',
      // Grant full permissions for service-authenticated requests
      // Individual endpoints can still validate specific permissions if needed
      permissions: ['all']
    };

    console.log(`[Service Auth] Authenticated ${userType} ${userId} via service key`);
    next();

  } catch (error: any) {
    console.error('[Service Auth] Error:', error);
    ApiResponseUtil.error(res, 'Service authentication failed', 500);
  }
};

/**
 * Dual Authentication Middleware
 *
 * Accepts either:
 * 1. JWT token (Authorization header) - for direct dashboard access
 * 2. Service key (x-service-key header) - for proxied app requests
 *
 * This allows the same endpoints to be accessed via both methods
 */
export const dualAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const serviceKey = req.headers['x-service-key'] as string;
    const authHeader = req.headers.authorization;

    // Try service auth first (most common for app requests)
    if (serviceKey) {
      serviceAuth(req, res, next);
      return;
    }

    // Fall back to JWT auth (for dashboard)
    if (authHeader) {
      const { authenticateTickets } = await import('./ticketsAuth.middleware');
      authenticateTickets(req, res, next);
      return;
    }

    // No authentication provided
    ApiResponseUtil.unauthorized(res, 'Authentication required (JWT token or service key)');
  } catch (error: any) {
    console.error('[Dual Auth] Error:', error);
    ApiResponseUtil.error(res, 'Authentication failed', 500);
  }
};
