import { Follow } from '@models/follow.model';
import { Buyer, IBuyer } from '@models/buyer.model';
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
    const buyers = await Buyer.find({ _id: { $in: ids }, socialSuspendedAt: null });
    const bMap = new Map(buyers.map((b) => [String(b._id), b]));
    return ranked
      .map(([id, mutualCount]) => ({ buyer: bMap.get(id), mutualCount }))
      .filter((x) => x.buyer) as Array<{ buyer: IBuyer; mutualCount: number }>;
  }
}
