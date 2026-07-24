import { Types } from 'mongoose';
import { Buyer } from '@models/buyer.model';
import { BlockService } from '@services/block.service';
import { FollowService } from '@services/follow.service';
import { onlineBuyerIds } from '@utils/buyerOnline.util';

export const NEARBY_DEFAULT_RADIUS_KM = 25;
export const NEARBY_MIN_RADIUS_KM = 1;
export const NEARBY_MAX_RADIUS_KM = 200;
const NEARBY_LIMIT = 30;

/** Data-shaped candidate — NOT the final API DTO (the controller adds the
 *  presentation-only `city`/`currentEvent` placeholders and rounds distance). */
export interface NearbyCandidate {
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  bio: string | null;
  distanceMeters: number;
  online: boolean;
  mutualCount: number;
}

export class NearbyService {
  /** Clamp a requested radius into the supported band; falls back to the
   *  default when absent/not-a-number (never rejects — unlike lat/lng, which
   *  the controller validates and 400s on). */
  static resolveRadiusKm(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return NEARBY_DEFAULT_RADIUS_KM;
    return Math.min(NEARBY_MAX_RADIUS_KM, Math.max(NEARBY_MIN_RADIUS_KM, n));
  }

  /**
   * Buyers who opted into location sharing, within `radiusKm` of (lat, lng),
   * nearest first. Excludes: the viewer, buyers blocked in EITHER direction,
   * buyers with no username, socially-suspended buyers, and — implicitly,
   * because the 2dsphere index is sparse — buyers who never set a location.
   */
  static async nearbyPeople(
    viewerId: string,
    lat: number,
    lng: number,
    radiusKm: number
  ): Promise<NearbyCandidate[]> {
    const [iBlocked, blockedMe] = await Promise.all([
      BlockService.listBlockedIds(viewerId),
      BlockService.listBlockerIds(viewerId),
    ]);
    const excludedIds = [viewerId, ...iBlocked, ...blockedMe].map((id) => new Types.ObjectId(id));

    const rows = await Buyer.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: {
            _id: { $nin: excludedIds },
            username: { $exists: true, $ne: null },
            socialSuspendedAt: null,
          },
        },
      },
      { $limit: NEARBY_LIMIT },
      { $project: { name: 1, username: 1, avatarUrl: 1, bio: 1, distanceMeters: 1 } },
    ]);

    if (rows.length === 0) return [];

    const ids = rows.map((r: any) => String(r._id));
    const [online, viewerFollowing] = await Promise.all([
      onlineBuyerIds(ids),
      FollowService.followingIds(viewerId, 'buyer'),
    ]);
    const onlineSet = new Set(online);
    const viewerFollowingSet = new Set(viewerFollowing);

    // Mutual = buyers BOTH the viewer and the candidate follow. Computed per
    // candidate over the (<=30) returned page — fine at this scale.
    const mutualCounts = await Promise.all(
      ids.map(async (id) => {
        const theirFollowing = await FollowService.followingIds(id, 'buyer');
        return theirFollowing.reduce((count, f) => count + (viewerFollowingSet.has(f) ? 1 : 0), 0);
      })
    );

    return rows.map((r: any, i: number) => ({
      id: String(r._id),
      name: r.name ?? null,
      username: r.username ?? null,
      avatarUrl: r.avatarUrl ?? null,
      bio: r.bio ?? null,
      distanceMeters: r.distanceMeters,
      online: onlineSet.has(String(r._id)),
      mutualCount: mutualCounts[i] ?? 0,
    }));
  }
}
