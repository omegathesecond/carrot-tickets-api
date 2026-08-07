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
import type { SocialActor } from '@utils/socialActor.util';

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

  /**
   * Resolve the acting community identity — a buyer OR an organizer brand.
   * A vendor/sub-user token acts AS the brand (no username needed); otherwise
   * we fall back to the buyer path (401s anonymous, ensures a username). Both
   * kinds can now join and post, so the write routes resolve through here.
   */
  private static async requireActor(req: Request, res: Response): Promise<SocialActor | null> {
    const organizer = organizerFromRequest(req);
    if (organizer) return { type: 'vendor', id: organizer.vendorId };
    const buyer = await CommunityController.requireBuyer(req, res);
    if (!buyer) return null;
    return { type: 'buyer', id: String(buyer._id) };
  }

  private static fail(res: Response, error: any, fallback: string) {
    return failWithHttpError(res, error, fallback);
  }

  static async join(req: Request, res: Response): Promise<any> {
    try {
      const actor = await CommunityController.requireActor(req, res);
      if (!actor) return;
      const view = await CommunityMembershipService.join(req.params['eventId'] as string, actor);
      return ApiResponseUtil.success(res, view, 'Joined community');
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to join community');
    }
  }

  static async getView(req: Request, res: Response): Promise<any> {
    try {
      const eventId = req.params['eventId'] as string;
      // Anonymous viewer (optionalCommunityViewer let them through): serve the
      // public who's-going view — memberCount + channels, no personal state.
      if (!(req as any).ticketsUser) {
        const view = await CommunityMembershipService.getPublicView(eventId);
        return ApiResponseUtil.success(res, view);
      }
      // A signed-in buyer OR brand: getView resolves their membership (or the
      // managing-brand read-only peek when a brand owns but hasn't joined).
      const actor = await CommunityController.requireActor(req, res);
      if (!actor) return;
      const view = await CommunityMembershipService.getView(eventId, actor);
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

      // The who's-going roster is public social proof — any viewer (signed-out
      // included, via optionalCommunityViewer) may read it. Names + avatars here
      // are the same public buyer summaries shown on profiles and the feed.
      // (Joining/messaging stays gated on the write routes.)
      const organizer = organizerFromRequest(req);
      if (organizer) {
        await assertOrganizerOwnsCommunity(community, organizer);
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
      const memberships = await Membership.find(query)
        .sort({ _id: -1 })
        .limit(limit)
        .populate('buyerId', 'username name avatarUrl')
        .populate('vendorId', 'businessName logoUrl');
      // Rows carry a `type` so the client can route to /o/:id (organizer) vs
      // /u/:username|:id (buyer) — the same buyer|organizer discriminator the
      // followers/search rows use.
      const members = memberships
        .map((m: any) => {
          if (m.vendorId && typeof m.vendorId === 'object') {
            return {
              id: String(m.vendorId._id),
              type: 'organizer' as const,
              username: null,
              name: m.vendorId.businessName ?? null,
              avatarUrl: m.vendorId.logoUrl ?? null,
              cursor: String(m._id),
            };
          }
          if (m.buyerId && typeof m.buyerId === 'object') {
            return { ...toBuyerSummary(m.buyerId), type: 'buyer' as const, cursor: String(m._id) };
          }
          return null;
        })
        .filter((r: unknown): r is NonNullable<typeof r> => r !== null);
      return ApiResponseUtil.success(res, members);
    } catch (error: any) {
      return CommunityController.fail(res, error, 'Failed to load members');
    }
  }
}
