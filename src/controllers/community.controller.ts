import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { CommunityMembershipService } from '@services/communityMembership.service';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { HttpError } from '@utils/httpError.util';
import { Membership } from '@models/membership.model';
import { Community } from '@models/community.model';
import { toBuyerSummary } from '@utils/buyerSummary.util';

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

  /** GET /api/community/:eventId/members — members see who's here (spec §2.4 find-people). */
  static async listMembers(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await CommunityController.requireBuyer(req, res);
      if (!buyer) return;
      const eventId = req.params['eventId'] as string;

      const community = await Community.findOne({ eventId });
      if (!community) throw new HttpError(404, 'Community not found for this event');
      const me = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
      if (!me || me.bannedAt) throw new HttpError(403, 'Join the community first');

      const limitRaw = req.query['limit'];
      let limit = 25;
      if (limitRaw !== undefined) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1) return ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
        limit = Math.min(limit, 50);
      }
      const before = req.query['before'] as string | undefined;
      if (before !== undefined && !/^[0-9a-f]{24}$/i.test(before)) {
        return ApiResponseUtil.error(res, 'before must be a member cursor', 400);
      }

      const query: Record<string, unknown> = { communityId: community._id, bannedAt: { $exists: false } };
      if (before) query['_id'] = { $lt: before };
      const memberships = await Membership.find(query).sort({ _id: -1 }).limit(limit).populate('buyerId');
      const members = memberships
        .filter((m: any) => m.buyerId && typeof m.buyerId === 'object')
        .map((m: any) => toBuyerSummary(m.buyerId));
      return ApiResponseUtil.success(res, members);
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to load members');
    }
  }
}
