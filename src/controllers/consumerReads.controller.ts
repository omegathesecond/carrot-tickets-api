import { Request, Response } from 'express';
import { resolveBuyerFromRequest } from '@/utils/buyerRequest.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { SavedContentService } from '@services/savedContent.service';
import { UpdateService } from '@services/update.service';
import { buildEventCards } from '@services/eventCards.service';
import { GoingService } from '@services/going.service';
import { CalendarService } from '@services/calendar.service';
import { FollowService } from '@services/follow.service';
import { SuggestionsService } from '@services/suggestions.service';
import { RecommendationsService } from '@services/recommendations.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { notEndedFilter } from '@utils/eventVisibility.util';

export class ConsumerReadsController {
  /** GET /api/social/me/saved */
  static async mySaved(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      const [savedUpdateDocs, savedEventIds] = await Promise.all([
        SavedContentService.listSavedUpdates(actor.id),
        SavedContentService.savedEventIds(actor.id),
      ]);
      const [updates, events] = await Promise.all([
        UpdateService.buildUpdateSlides(savedUpdateDocs, actor),
        buildEventCards(savedEventIds, actor),
      ]);
      return ApiResponseUtil.success(res, { updates, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load saved items');
    }
  }

  /** GET /api/social/me/going — events the buyer joined the community of, or holds a live ticket for. */
  static async myGoing(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = await GoingService.goingEventIds(buyer);
      const events = await buildEventCards(ids, { type: 'buyer', id: String(buyer._id) });
      return ApiResponseUtil.success(res, { events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load your events');
    }
  }

  /** GET /api/social/me/calendar?year= — going + saved events in `year`, grouped by month. */
  static async myCalendar(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const year = Number(req.query['year']) || new Date().getUTCFullYear();
      const { monthCounts, eventIds } = await CalendarService.forYear(buyer, year);
      const events = await buildEventCards(eventIds, { type: 'buyer', id: String(buyer._id) });
      return ApiResponseUtil.success(res, { monthCounts, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load your calendar');
    }
  }

  /** GET /api/social/me/following/events — upcoming published events by organizers the buyer follows. */
  static async myFollowingEvents(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const vendorIds = await FollowService.followingIds(String(buyer._id), 'organizer');
      let events: any[] = [];
      if (vendorIds.length) {
        const rows = await Event.find({ vendorId: { $in: vendorIds }, status: EventStatus.PUBLISHED, ...notEndedFilter() })
          .sort({ eventDate: 1 })
          .select('_id');
        events = await buildEventCards(rows.map((e) => String(e._id)), { type: 'buyer', id: String(buyer._id) });
      }
      return ApiResponseUtil.success(res, { events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load followed events');
    }
  }

  /** GET /api/social/suggestions/people — "people you may know". */
  static async suggestedPeople(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const rows = await SuggestionsService.peopleYouMayKnow(String(buyer._id));
      const data = rows.map(({ buyer: b, mutualCount }) => ({
        id: String(b._id),
        name: b.name ?? null,
        username: b.username ?? null,
        avatarUrl: b.avatarUrl ?? null,
        bio: b.bio ?? null,
        city: null,
        mutualCount,
        isFollowing: false,
      }));
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load suggestions');
    }
  }

  /** GET /api/social/suggestions/organizers — "organizers to follow". */
  static async suggestedOrganizers(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const rows = await SuggestionsService.organizersToFollow(String(buyer._id));
      const data = rows.map(({ vendor: v, eventCount, followerCount, isFollowing }) => ({
        id: String(v._id),
        businessName: v.businessName,
        logoUrl: v.logoUrl ?? null,
        location: v.address?.city ?? null,
        eventCount,
        followerCount,
        isFollowing,
      }));
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load organizer suggestions');
    }
  }

  /** GET /api/social/recommendations — "because you saved X" (v1: same-organizer + soonest-upcoming). */
  static async recommendations(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { basisEvent, eventIds } = await RecommendationsService.forBuyer(String(buyer._id));
      const events = await buildEventCards(eventIds, { type: 'buyer', id: String(buyer._id) });
      return ApiResponseUtil.success(res, { basisEvent, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load recommendations');
    }
  }
}
