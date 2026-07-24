import { Follow } from '@models/follow.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';
import { FollowService } from '@services/follow.service';

export class SuggestionsService {
  /** Friends-of-friends the buyer doesn't already follow, ranked by shared
   *  connections. Falls back to recently-active handled buyers when the buyer
   *  follows no one yet (mutualCount 0). Excludes self, already-followed and
   *  socially-suspended buyers. */
  static async peopleYouMayKnow(buyerId: string, limit = 20): Promise<Array<{ buyer: IBuyer; mutualCount: number }>> {
    const iFollow = await FollowService.followingIds(buyerId, 'buyer');
    const exclude = new Set<string>([buyerId, ...iFollow]);

    if (iFollow.length === 0) {
      const recent = await Buyer.find({ _id: { $nin: [...exclude] }, username: { $exists: true, $ne: null }, socialSuspendedAt: null })
        .sort({ lastLoginAt: -1 })
        .limit(limit);
      return recent.map((b) => ({ buyer: b, mutualCount: 0 }));
    }

    const secondDegree = await Follow.find({ followerType: 'buyer', followerId: { $in: iFollow }, targetType: 'buyer' }).select('targetId');
    const counts = new Map<string, number>();
    for (const r of secondDegree) {
      const id = String(r.targetId);
      if (!exclude.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const ids = ranked.map(([id]) => id);
    const buyers = await Buyer.find({ _id: { $in: ids }, socialSuspendedAt: null, username: { $exists: true, $ne: null } });
    const bMap = new Map(buyers.map((b) => [String(b._id), b]));
    return ranked
      .map(([id, mutualCount]) => ({ buyer: bMap.get(id), mutualCount }))
      .filter((x) => x.buyer) as Array<{ buyer: IBuyer; mutualCount: number }>;
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
    buyerId: string,
    limit = 20
  ): Promise<Array<{ vendor: any; eventCount: number; followerCount: number; isFollowing: boolean }>> {
    const rows = await Vendor.aggregate([
      { $match: { isActive: true, verificationStatus: VerificationStatus.VERIFIED } },
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
      { $sort: { followerCount: -1 } },
      { $limit: limit },
      { $project: { businessName: 1, logoUrl: 1, address: 1, followerCount: 1, eventCount: 1 } },
    ]);

    const following = new Set(await FollowService.followingIds(buyerId, 'organizer'));
    return rows.map((v: any) => ({
      vendor: v,
      followerCount: v.followerCount,
      eventCount: v.eventCount,
      isFollowing: following.has(String(v._id)),
    }));
  }
}
