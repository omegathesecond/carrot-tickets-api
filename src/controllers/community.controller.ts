import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { CommunityMembershipService } from '@services/communityMembership.service';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { HttpError } from '@utils/httpError.util';
import { Membership } from '@models/membership.model';
import { Community } from '@models/community.model';
import { toBuyerSummary } from '@utils/buyerSummary.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { organizerFromRequest, assertOrganizerOwnsCommunity } from '@utils/communityViewer.util';

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
    return failWithHttpError(res, error, fallback);
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
      const eventId = req.params['eventId'] as string;
      // An organizer token gets the read-only owner peek; a buyer token gets
      // the normal member view (resolved via their phone/Membership).
      const organizer = organizerFromRequest(req);
      if (organizer) {
        const view = await CommunityMembershipService.getOrganizerView(eventId, organizer);
        return ApiResponseUtil.success(res, view);
      }
      const buyer = await CommunityController.requireBuyer(req, res);
      if (!buyer) return;
      const view = await CommunityMembershipService.getView(eventId, buyer);
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

  /**
   * GET /api/community/:eventId/members — members see who's here (spec §2.4 find-people).
   * `before` = the `cursor` field of the last item in the previous page (a Membership id, not a buyer id).
   */
  static async listMembers(req: Request, res: Response): Promise<any> {
    try {
      const eventId = req.params['eventId'] as string;

      const community = await Community.findOne({ eventId });
      if (!community) throw new HttpError(404, 'Community not found for this event');

      // Organizer peek: gate on ownership. Buyer: gate on their own (un-banned)
      // membership — attendees can only see the roster once they've joined.
      const organizer = organizerFromRequest(req);
      if (organizer) {
        await assertOrganizerOwnsCommunity(community, organizer);
      } else {
        const buyer = await CommunityController.requireBuyer(req, res);
        if (!buyer) return;
        const me = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
        if (!me || me.bannedAt) throw new HttpError(403, 'Join the community first');
      }

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
        .map((m: any) => ({ ...toBuyerSummary(m.buyerId), cursor: String(m._id) }));
      return ApiResponseUtil.success(res, members);
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to load members');
    }
  }
}
