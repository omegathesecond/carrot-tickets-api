import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveActorFromRequest, type SocialActor } from '@utils/socialActor.util';
import { SuggestionsService } from '@services/suggestions.service';
import { NearbyService } from '@services/nearby.service';
import { RecommendationsService } from '@services/recommendations.service';
import { buildEventCards } from '@services/eventCards.service';
import { Vendor } from '@models/vendor.model';
import { locationSchema } from '@validators/community.validator';
import { parseSeed } from '@utils/seededShuffle.util';

/**
 * Organizer-brand (Vendor) equivalents of ConsumerReadsController's
 * suggestions / recommendations / nearby / location surfaces. Same DTOs, same
 * ranking services — the only difference is the acting identity is a vendor
 * (resolveActorFromRequest → { type: 'vendor', id }), so a brand gets the same
 * "who to follow / what's near me" experience a buyer does. Mounted under
 * /api/tickets/social (authenticateTickets).
 */
export class VendorConsumerReadsController {
  /** The vendor actor for this tickets session, or null if not a vendor token. */
  private static async vendorActor(req: Request): Promise<SocialActor | null> {
    const actor = await resolveActorFromRequest(req);
    return actor && actor.type === 'vendor' ? actor : null;
  }

  private static parsePageLimit(req: Request): { page: number; limit: number; seed: number | undefined } {
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));
    return { page, limit, seed: parseSeed(req.query['seed']) };
  }

  /** GET /api/tickets/social/suggestions/people — "people you may know" for a brand. */
  static async suggestedPeople(req: Request, res: Response): Promise<any> {
    try {
      const actor = await VendorConsumerReadsController.vendorActor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { page, limit, seed } = VendorConsumerReadsController.parsePageLimit(req);
      const rows = await SuggestionsService.peopleYouMayKnow(actor, { page, limit, seed });
      const data = rows.map(({ buyer: b, mutualCount }) => ({
        id: String(b._id),
        name: b.name ?? null,
        username: b.username ?? null,
        avatarUrl: b.avatarUrl ?? null,
        bio: b.bio ?? null,
        city: b.city ?? null,
        mutualCount,
        isFollowing: false,
      }));
      return ApiResponseUtil.success(res, data);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load suggestions');
    }
  }

  /** GET /api/tickets/social/suggestions/organizers — other organizers a brand may follow (never itself). */
  static async suggestedOrganizers(req: Request, res: Response): Promise<any> {
    try {
      const actor = await VendorConsumerReadsController.vendorActor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { page, limit, seed } = VendorConsumerReadsController.parsePageLimit(req);
      const rows = await SuggestionsService.organizersToFollow(actor, { page, limit, seed });
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

  /** GET /api/tickets/social/recommendations — soonest-upcoming events for a brand (no saved basis). */
  static async recommendations(req: Request, res: Response): Promise<any> {
    try {
      const actor = await VendorConsumerReadsController.vendorActor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const seed = parseSeed(req.query['seed']);
      const { basisEvent, eventIds } = await RecommendationsService.forViewer(actor, { seed });
      const events = await buildEventCards(eventIds, actor);
      return ApiResponseUtil.success(res, { basisEvent, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load recommendations');
    }
  }

  /** GET /api/tickets/social/nearby/people?lat=&lng=&radiusKm= — people near the brand. */
  static async nearbyPeople(req: Request, res: Response): Promise<any> {
    try {
      const actor = await VendorConsumerReadsController.vendorActor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');

      const lat = Number(req.query['lat']);
      const lng = Number(req.query['lng']);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return ApiResponseUtil.error(res, 'lat must be a number between -90 and 90', 400);
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return ApiResponseUtil.error(res, 'lng must be a number between -180 and 180', 400);
      }
      const radiusKm = NearbyService.resolveRadiusKm(req.query['radiusKm']);

      const rows = await NearbyService.nearbyPeople(actor, lat, lng, radiusKm);
      const people = rows.map((r) => ({
        id: r.id,
        name: r.name,
        username: r.username,
        avatarUrl: r.avatarUrl,
        bio: r.bio,
        city: null,
        distanceKm: Math.round((r.distanceMeters / 1000) * 10) / 10,
        online: r.online,
        mutualCount: r.mutualCount,
        currentEvent: null,
      }));
      return ApiResponseUtil.success(res, { people });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load nearby people');
    }
  }

  /** PATCH /api/tickets/social/me/location — a brand opts into location sharing. */
  static async updateLocation(req: Request, res: Response): Promise<any> {
    try {
      const actor = await VendorConsumerReadsController.vendorActor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = locationSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const location = { type: 'Point' as const, coordinates: [value.lng, value.lat] as [number, number] };
      const locationUpdatedAt = new Date();
      await Vendor.updateOne({ _id: actor.id }, { $set: { location, locationUpdatedAt } });
      return ApiResponseUtil.success(res, { ok: true, location, locationUpdatedAt }, 'Location updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update location');
    }
  }

  /** DELETE /api/tickets/social/me/location — a brand stops sharing its location. */
  static async deleteLocation(req: Request, res: Response): Promise<any> {
    try {
      const actor = await VendorConsumerReadsController.vendorActor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await Vendor.updateOne({ _id: actor.id }, { $unset: { location: 1, locationUpdatedAt: 1 } });
      return ApiResponseUtil.success(res, { ok: true }, 'Location removed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove location');
    }
  }
}
