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

// Safety cap on the recently-active top-up pool — big enough to never matter
// for a real friends-of-friends graph, small enough to keep a full-collection
// scan off the table. Ranking then happens across this whole pool (not just
// the first page), same "don't cap before ranking" reasoning as
// organizersToFollow below.
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

// "Genuine profile picture" — avatarUrl is only ever written by an explicit
// upload (BuyerProfileController), never auto-generated, so its presence
// alone is enough to rule out an initials/placeholder avatar (a null
// avatarUrl is exactly what renders as an initials circle client-side).
const GENUINE_AVATAR_FILTER = { avatarUrl: { $exists: true, $nin: [null, ''] } };

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
   *  suggestionCompositeScore). Tops the candidate set up with recently-active
   *  handled buyers (mutualCount 0) whenever friends-of-friends alone does not
   *  fill the scoring pool, so a buyer who follows nobody — or who follows
   *  only people who follow nobody — still gets suggestions. Excludes self,
   *  already-followed, socially-suspended buyers, and anyone without a
   *  genuine uploaded profile picture (see GENUINE_AVATAR_FILTER) — a buyer
   *  who never uploaded a photo renders as an initials/placeholder circle,
   *  which is exactly what this list must not surface. Paginated via
   *  `page`/`limit` over the fully ranked candidate set, so pagination is
   *  deterministic. */
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

    const candidates: Array<{ id: string; mutualCount: number }> = [];
    // Everyone already spoken for: self, already-followed, and (below) every
    // friend-of-friend we have already queued — so the top-up can never
    // duplicate a candidate we are about to rank.
    const claimed = new Set<string>(exclude);

    if (iFollow.length > 0) {
      const secondDegree = await Follow.find({ followerType: 'buyer', followerId: { $in: iFollow }, targetType: 'buyer' }).select('targetId');
      const counts = new Map<string, number>();
      for (const r of secondDegree) {
        const id = String(r.targetId);
        if (!exclude.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const [id, mutualCount] of counts) {
        candidates.push({ id, mutualCount });
        claimed.add(id);
      }
    }

    // Top up a short friends-of-friends set with recently-active buyers rather
    // than returning a thin (or empty) list. Gating this on
    // `iFollow.length === 0` — as it used to — meant following your very first
    // person moved you OFF the recently-active pool and onto a
    // friends-of-friends graph that is empty until someone you follow follows
    // someone else, so suggestions collapsed to [] right after signup. These
    // carry mutualCount 0, and MUTUAL_WEIGHT dominates the composite score, so
    // a genuine friend-of-friend always outranks a top-up.
    //
    // The threshold is CANDIDATE_SCORE_CAP, not the caller's page — a
    // page-dependent top-up would rank page 2 over a different candidate set
    // than page 1 and let the two pages overlap under `seed`.
    if (candidates.length < CANDIDATE_SCORE_CAP) {
      const recent = await Buyer.find({
        _id: { $nin: [...claimed] },
        username: { $exists: true, $ne: null },
        socialSuspendedAt: null,
        ...GENUINE_AVATAR_FILTER,
      })
        .select('_id')
        .sort({ lastLoginAt: -1 })
        .limit(FALLBACK_CANDIDATE_POOL_CAP);
      for (const b of recent) candidates.push({ id: String(b._id), mutualCount: 0 });
    }
    if (candidates.length === 0) return [];

    // Cap BEFORE scoring (see CANDIDATE_SCORE_CAP) — sort by mutualCount desc
    // with an _id tiebreak for determinism, then take only the top-K into the
    // (relatively) expensive shared-event resolution below.
    candidates.sort((a, b) =>
      b.mutualCount !== a.mutualCount ? b.mutualCount - a.mutualCount : a.id.localeCompare(b.id)
    );
    const scoreable = candidates.slice(0, CANDIDATE_SCORE_CAP);

    const buyers = await Buyer.find({
      _id: { $in: scoreable.map((c) => c.id) },
      socialSuspendedAt: null,
      username: { $exists: true, $ne: null },
      ...GENUINE_AVATAR_FILTER,
    });
    const bMap = new Map(buyers.map((b) => [String(b._id), b]));

    const viewerGoingEventIds = viewer ? new Set(await GoingService.goingEventIds(viewer)) : new Set<string>();
    const viewerCity = normalizeCity(viewer?.city);

    const eligible = scoreable.filter((c) => bMap.has(c.id));
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
    //
    // The shuffle runs WITHIN the friends-of-friends tier and the top-up tier
    // separately, never across them. Shuffling the two together would scatter
    // a handful of genuine connections through a much larger pool of
    // strangers — and since the UI always sends a seed, that is the path that
    // actually ships. Each tier alone shuffles exactly as it did before, so a
    // viewer with no top-ups (or no connections) is unaffected.
    const ordered = seed === undefined
      ? [...scored].sort((a, b) =>
          b.score !== a.score ? b.score - a.score : String(a.buyer._id).localeCompare(String(b.buyer._id))
        )
      : [
          ...seededShuffle(scored.filter((c) => c.mutualCount > 0), seed),
          ...seededShuffle(scored.filter((c) => c.mutualCount === 0), seed),
        ];

    const skip = (Math.max(1, page) - 1) * limit;
    return ordered.slice(skip, skip + limit).map(({ buyer, mutualCount }) => ({ buyer, mutualCount }));
  }

  /** Active, verified organizers to follow, ranked by isFollowing (not
   *  already followed first — see below), then eventCount (has this
   *  organizer actually published something), then followerCount. May still
   *  include organizers the buyer already follows (marked isFollowing:true)
   *  — this stays a directory, not a hard exclusion list like
   *  peopleYouMayKnow — but they sort behind everyone not yet followed, so
   *  the section reads as "to follow", not "people you follow already".
   *
   *  Single aggregation across ALL verified vendors (not just the first 100),
   *  so the most-active organizer can always surface — the old
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

    const followingIds = await FollowService.followingIds(actor.id, 'organizer', actor.type);
    const followingObjectIds = followingIds.map((id) => new Types.ObjectId(id));

    // Follower/event-count lookups, shared by the established AND the fresh
    // top-up pipeline below, so a newly-registered organizer's counts are
    // real rather than assumed-zero.
    const countStages: any[] = [
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
          isFollowing: { $in: ['$_id', followingObjectIds] },
        },
      },
    ];

    // Ranking pipeline shared by both paths — identical to the pre-shuffle
    // version up to and including the $project.
    const basePipeline: any[] = [
      { $match: match },
      ...countStages,
      // isFollowing is now the PRIMARY sort key — an organizer the buyer
      // already follows doesn't need "suggesting" again, so it drops behind
      // every not-yet-followed organizer (still included, never excluded,
      // per the class doc above). eventCount is the next signal, not
      // followerCount: a brand new organizer starts at 0 followers by
      // definition — the moment they publish their first event is exactly
      // the moment they should surface. Sorting by followerCount first (even
      // with an eventCount tiebreak) still permanently buried them behind
      // ANY organizer with even one follower, including dormant/test
      // accounts that never published a single event — that was reported
      // again after the previous tiebreak fix shipped (organizers with a
      // handful of stale followers and 0 events kept outranking active new
      // organizers with real events). followerCount now only breaks ties
      // among organizers who are equally active (same eventCount); _id DESC
      // is the final tiebreak, favoring the most recently registered
      // organizer. Still fully deterministic for pagination.
      { $sort: { isFollowing: 1, eventCount: -1, followerCount: -1, _id: -1 } },
      { $project: { businessName: 1, logoUrl: 1, address: 1, followerCount: 1, eventCount: 1, isFollowing: 1 } },
    ];

    let rows: any[];
    if (seed === undefined) {
      // Deterministic path — the caller's exact page, ranked by isFollowing then eventCount then follower count.
      rows = await Vendor.aggregate([...basePipeline, { $skip: skip }, { $limit: limit }]);
    } else {
      // Seeded path — a bounded quality pool (top organizers by isFollowing,
      // eventCount then follower count), seed-shuffled in-app then
      // paginated, so a repeat visit doesn't keep showing the same handful.
      // Established organizers stay in the pool but are no longer
      // permanently pinned to the top.
      const POOL_SIZE = Math.max(60, limit * 3);
      const established = await Vendor.aggregate([...basePipeline, { $limit: POOL_SIZE }]);

      // Top up with the most-recently-registered verified organizers not
      // already in the established pool — an organizer who just signed up
      // and hasn't accumulated events/followers yet would otherwise sit
      // permanently past POOL_SIZE and never get a chance to rotate in
      // (same "don't let a thin signal collapse to nothing" reasoning as
      // peopleYouMayKnow's recently-active top-up above).
      const seenIds = established.map((v: any) => v._id);
      const FRESH_POOL_SIZE = Math.max(20, limit);
      // Merge onto match's own `_id` (only present for a vendor actor
      // excluding itself) rather than overwriting it — losing that exclusion
      // would let a vendor actor see itself in its own "to follow" pool.
      const existingIdFilter = (match['_id'] as Record<string, unknown>) ?? {};
      const freshMatch: Record<string, unknown> = { ...match, _id: { ...existingIdFilter, $nin: seenIds } };
      const fresh = await Vendor.aggregate([
        { $match: freshMatch },
        { $sort: { createdAt: -1 } },
        { $limit: FRESH_POOL_SIZE },
        ...countStages,
        { $project: { businessName: 1, logoUrl: 1, address: 1, followerCount: 1, eventCount: 1, isFollowing: 1 } },
      ]);

      rows = seededShuffle([...established, ...fresh], seed).slice(skip, skip + limit);
    }

    return rows.map((v: any) => ({
      vendor: v,
      followerCount: v.followerCount,
      eventCount: v.eventCount,
      isFollowing: v.isFollowing,
    }));
  }
}
