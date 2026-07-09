import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { CommunityMembershipService } from '@services/communityMembership.service';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { HttpError } from '@utils/httpError.util';

export class CommunityController {
  /** Resolve the buyer and make sure they carry a username before any social action. */
  private static async requireBuyer(req: Request, res: Response) {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) {
      ApiResponseUtil.unauthorized(res, 'Please sign in first');
      return null;
    }
    return ensureUsername(buyer);
  }

  private static fail(res: Response, error: any, fallback: string) {
    if (error instanceof HttpError) return ApiResponseUtil.error(res, error.message, error.statusCode);
    console.error(fallback, error);
    return ApiResponseUtil.error(res, error?.message || fallback, 500);
  }

  static async join(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await CommunityController.requireBuyer(req, res);
      if (!buyer) return;
      const view = await CommunityMembershipService.join(req.params['eventId'] as string, buyer);
      return ApiResponseUtil.success(res, view, 'Joined community');
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to join community');
    }
  }

  static async getView(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await CommunityController.requireBuyer(req, res);
      if (!buyer) return;
      const view = await CommunityMembershipService.getView(req.params['eventId'] as string, buyer);
      return ApiResponseUtil.success(res, view);
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to load community');
    }
  }

  static async reverifyTicket(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await CommunityController.requireBuyer(req, res);
      if (!buyer) return;
      const view = await CommunityMembershipService.reverifyTicket(req.params['eventId'] as string, buyer);
      return ApiResponseUtil.success(res, view, 'Ticket verification refreshed');
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to verify ticket');
    }
  }
}
