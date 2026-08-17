import { Types } from 'mongoose';
import { Follow } from '@models/follow.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';
import { FollowService } from '@services/follow.service';
import { GoingService } from '@services/going.service';
import { seededShuffle } from '@utils/seededShuffle.util';
import type { SocialActor } from '@utils/socialActor.util';

export interface SuggestionsPageOptions {
  limit?: number;
  page?: number;
  seed?: number;
}

// Safety cap on the "follows no one" fallback candidate pool — big enough to
// never matter for a real friends-of-friends graph, small enough to keep a
// full-collection scan off the table. Ranking then happens across this whole
// pool (not just the first page), same "don't cap before ranking" reasoning
// as organizersToFollow below.
const FALLBACK_CANDIDATE_POOL_CAP = 1000;

// Cap on how many candidates get scored (shared-event resolution + the full
// composite score) per request. mutualCount dominates the composite score by
// construction (MUTUAL_WEIGHT is larger than the max possible combined
// contribution of sharedEventCount+city+recency — see the weight constants
// below), so taking the top-K by mutualCount BEFORE scoring is guaranteed to
// contain the eventual top-K ranked results. Without this cap, a
// well-connected viewer's friends-of-friends set is unbounded, and used to
// fan out one GoingService query PER candidate.
const CANDIDATE_SCORE_CAP = 200;

// Composite ranking weights, ordered so each signal can only ever break a TIE
// in the signal above it — mutualCount (friends-of-friends) is primary,
// shared-event attendance is the first tiebreaker, same-city the second,
// recency (lastLoginAt) the last. Clamps (Math.min(999, ...) on event count,
// RECENCY_MAX staying under CITY_WEIGHT) keep that ordering guaranteed
// regardless of how large any one signal gets, so pagination stays stable.
const MUTUAL_WEIGHT = 1_000_000;
const EVENT_WEIGHT = 1_000;
const CITY_WEIGHT = 10;
const RECENCY_MAX = 5;

function recencyScore(lastLoginAt?: Date | null): number {
  if (!lastLoginAt) return 0;
  const daysSince = Math.max(0, (Date.now() - lastLoginAt.getTime()) / 86_400_000);
  return RECENCY_MAX / (1 + daysSince);
}

function normalizeCity(city?: string | null): string | null {
  const trimmed = city?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Pure composite ranking score for "people you may know" — exported for
 *  direct unit testing. Higher ranks first. See the weight constants above
 *  for why mutualCount can never be overtaken by the other signals. */
export function suggestionCompositeScore(input: {
  mutualCount: number;
  sharedEventCount: number;
  sameCity: boolean;
  lastLoginAt?: Date | null;
}): number {
  const mutual = Math.max(0, input.mutualCount);
  const events = Math.min(999, Math.max(0, input.sharedEventCount));
  return mutual * MUTUAL_WEIGHT + events * EVENT_WEIGHT + (input.sameCity ? CITY_WEIGHT : 0) + recencyScore(input.lastLoginAt);
}

export class SuggestionsService {
  /** Friends-of-friends the buyer doesn't already follow, ranked by a
   *  composite score: mutual-connection count (primary) blended with shared
   *  event attendance, same city, and recency (in that priority order — see
   *  suggestionCompositeScore). Falls back to the same composite ranking
   *  over recently-active handled buyers when the buyer follows no one yet
   *  (mutualCount 0 for all of them). Excludes self, already-followed and
   *  socially-suspended buyers. Paginated via `page`/`limit` over the fully
   *  ranked candidate set, so pagination is deterministic. */
  static async peopleYouMayKnow(
    actor: SocialActor,
    { limit = 20, page = 1, seed }: SuggestionsPageOptions = {}
  ): Promise<Array<{ buyer: IBuyer; mutualCount: number }>> {
    // Viewer profile (city + shared-event signals) only exists for a buyer
    // actor. A vendor brand has no Buyer row, so those two composite-score
    // signals simply fall to 0/false and ranking leans on mutual-count +
    // recency — the follow-graph half below works identically for either actor.
    const viewer = actor.type === 'buyer' ? await Buyer.findById(actor.id) : null;
    const iFollow = await FollowService.followingIds(actor.id, 'buyer', actor.type);
    // A vendor id is never a buyer candidate, so self-exclusion only matters
    // for a buyer viewer.
    const exclude = new Set<string>(actor.type === 'buyer' ? [actor.id, ...iFollow] : iFollow);

    let candidates: Array<{ id: string; mutualCount: number }>;
    if (iFollow.length === 0) {
      const recent = await Buyer.find({ _id: { $nin: [...exclude] }, username: { $exists: true, $ne: null }, socialSuspendedAt: null })
        .select('_id')
        .sort({ lastLoginAt: -1 })
        .limit(FALLBACK_CANDIDATE_POOL_CAP);
      candidates = recent.map((b) => ({ id: String(b._id), mutualCount: 0 }));
    } else {
      const secondDegree = await Follow.find({ followerType: 'buyer', followerId: { $in: iFollow }, targetType: 'buyer' }).select('targetId');
      const counts = new Map<string, number>();
      for (const r of secondDegree) {
        const id = String(r.targetId);
        if (!exclude.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      candidates = [...counts.entries()].map(([id, mutualCount]) => ({ id, mutualCount }));
    }
    if (candidates.length === 0) return [];

    // Cap BEFORE scoring (see CANDIDATE_SCORE_CAP) — sort by mutualCount desc
    // with an _id tiebreak for determinism, then take only the top-K into the
    // (relatively) expensive shared-event resolution below.
    candidates.sort((a, b) =>
      b.mutualCount !== a.mutualCount ? b.mutualCount - a.mutualCount : a.id.localeCompare(b.id)
    );
    candidates = candidates.slice(0, CANDIDATE_SCORE_CAP);

    const buyers = await Buyer.find({
      _id: { $in: candidates.map((c) => c.id) },
      socialSuspendedAt: null,
      username: { $exists: true, $ne: null },
    });
    const bMap = new Map(buyers.map((b) => [String(b._id), b]));

    const viewerGoingEventIds = viewer ? new Set(await GoingService.goingEventIds(viewer)) : new Set<string>();
    const viewerCity = normalizeCity(viewer?.city);

    const eligible = candidates.filter((c) => bMap.has(c.id));
    // Batch-resolve every candidate's going-eventIds in a FIXED number of
    // queries (see GoingService.goingEventIdsBatch), instead of one
    // GoingService.goingEventIds call per candidate.
    const goingByBuyerId = viewerGoingEventIds.size
      ? await GoingService.goingEventIdsBatch(eligible.map((c) => bMap.get(c.id) as IBuyer))
      : new Map<string, Set<string>>();

    const scored = eligible.map((c) => {
      const buyer = bMap.get(c.id) as IBuyer;
      const candidateEventIds = goingByBuyerId.get(c.id) ?? new Set<string>();
      let sharedEventCount = 0;
      for (const id of candidateEventIds) if (viewerGoingEventIds.has(id)) sharedEventCount++;
      const sameCity = Boolean(viewerCity) && normalizeCity(buyer.city) === viewerCity;
      const score = suggestionCompositeScore({
        mutualCount: c.mutualCount,
        sharedEventCount,
        sameCity,
        lastLoginAt: buyer.lastLoginAt ?? null,
      });
      return { buyer, mutualCount: c.mutualCount, score };
    });

    // seed present → shuffle the quality pool; absent → today's composite-score
    // ranking. Both paginate the same way, so pages stay stable within a visit.
    const ordered = seed === undefined
      ? [...scored].sort((a, b) =>
          b.score !== a.score ? b.score - a.score : String(a.buyer._id).localeCompare(String(b.buyer._id))
        )
      : seededShuffle(scored, seed);

    const skip = (Math.max(1, page) - 1) * limit;
    return ordered.slice(skip, skip + limit).map(({ buyer, mutualCount }) => ({ buyer, mutualCount }));
  }

  /** Active, verified organizers to follow, ranked by follower count. May
   *  include organizers the buyer already follows (marked isFollowing:true) —
   *  this is a directory, not an exclusion list like peopleYouMayKnow.
   *
   *  Single aggregation across ALL verified vendors (not just the first 100),
   *  so the most-followed organizer can always surface — the old
   *  find().limit(100) + per-vendor count queries capped the candidate pool
   *  BEFORE ranking, which meant a popular organizer past the 100th row could
   *  never appear, on top of firing ~2 queries per vendor. */
  static async organizersToFollow(
    actor: SocialActor,
    { limit = 20, page = 1, seed }: SuggestionsPageOptions = {}
  ): Promise<Array<{ vendor: any; eventCount: number; followerCount: number; isFollowing: boolean }>> {
    const skip = (Math.max(1, page) - 1) * limit;

    // A vendor viewing "organizers to follow" must never be offered itself.
    // Super-admin brands (the platform admin account) are never a real organizer
    // to follow — keep them out of the public directory, same as adminOrganizers.
    const match: Record<string, unknown> = { isActive: true, verificationStatus: VerificationStatus.VERIFIED, isSuperAdmin: { $ne: true } };
    if (actor.type === 'vendor') match['_id'] = { $ne: new Types.ObjectId(actor.id) };

    // Ranking pipeline shared by both paths — identical to the pre-shuffle
    // version up to and including the $project.
    const basePipeline: any[] = [
      { $match: match },
      {
        // Follower count for this organizer. `from` is read off the actual
        // registered Mongoose collection (not a hardcoded string) so a
        // rename can't silently produce a zero-count lookup.
        $lookup: {
          from: Follow.collection.name,
          let: { vendorId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$targetType', 'organizer'] }, { $eq: ['$targetId', '$$vendorId'] }] } } },
            { $count: 'count' },
          ],
          as: '_followers',
        },
      },
      {
        $lookup: {
          from: Event.collection.name,
          let: { vendorId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$vendorId', '$$vendorId'] }, { $eq: ['$status', EventStatus.PUBLISHED] }] } } },
            { $count: 'count' },
          ],
          as: '_events',
        },
      },
      {
        $addFields: {
          followerCount: { $ifNull: [{ $arrayElemAt: ['$_followers.count', 0] }, 0] },
          eventCount: { $ifNull: [{ $arrayElemAt: ['$_events.count', 0] }, 0] },
        },
      },
      // Stable tiebreak on _id keeps pagination deterministic when several
      // organizers tie on followerCount.
      { $sort: { followerCount: -1, _id: 1 } },
      { $project: { businessName: 1, logoUrl: 1, address: 1, followerCount: 1, eventCount: 1 } },
    ];

    let rows: any[];
    if (seed === undefined) {
      // Deterministic path — the caller's exact page, ranked by follower count.
      rows = await Vendor.aggregate([...basePipeline, { $skip: skip }, { $limit: limit }]);
    } else {
      // Seeded path — a bounded quality pool (top organizers by follower count),
      // seed-shuffled in-app then paginated. Established organizers stay in the
      // pool but are no longer permanently pinned to the top.
      const POOL_SIZE = Math.max(60, limit * 3);
      const pool = await Vendor.aggregate([...basePipeline, { $limit: POOL_SIZE }]);
      rows = seededShuffle(pool, seed).slice(skip, skip + limit);
    }

    const following = new Set(await FollowService.followingIds(actor.id, 'organizer', actor.type));
    return rows.map((v: any) => ({
      vendor: v,
      followerCount: v.followerCount,
      eventCount: v.eventCount,
      isFollowing: following.has(String(v._id)),
    }));
  }
}
