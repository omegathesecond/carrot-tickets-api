import { Follow, FollowTargetType } from '@models/follow.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { HttpError } from '@utils/httpError.util';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { assertNotSuspended } from '@utils/socialSuspension.util';

export class FollowService {
  static async follow(buyer: IBuyer, targetType: FollowTargetType, targetId: string): Promise<void> {
    assertNotSuspended(buyer);
    if (targetType === 'buyer' && String(buyer._id) === targetId) {
      throw new HttpError(400, 'You cannot follow yourself');
    }
    const exists =
      targetType === 'buyer' ? await Buyer.exists({ _id: targetId }) : await Vendor.exists({ _id: targetId });
    if (!exists) throw new HttpError(404, 'User not found');

    let created = false;
    try {
      await Follow.create({ followerId: buyer._id, targetType, targetId });
      created = true;
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // already following — idempotent
    }
    // Checked OUTSIDE the try so it fires on a fresh create AND survives a
    // retry after a transient error on the create itself — but never fires
    // on the pure-duplicate (already-following) path, since `created` stays
    // false there.
    if (created && targetType === 'buyer' && (await FollowService.isFriend(String(buyer._id), targetId))) {
      // buyer's follow completed the mutual — tell the other party.
      NotificationDispatcher.dispatchAsync(
        [targetId],
        'friend',
        buyer.username ?? buyer.name ?? 'Someone',
        'followed you back — you are now friends',
        // The notified party (targetId) is being told about buyer, their new
        // friend — username lets the client route straight to buyer's
        // profile, same identity buyerId already points at.
        { buyerId: String(buyer._id), username: buyer.username ?? null },
        String(buyer._id)
      );
    }
  }

  static async unfollow(buyer: IBuyer, targetType: FollowTargetType, targetId: string): Promise<void> {
    await Follow.deleteOne({ followerId: buyer._id, targetType, targetId });
  }

  /** Mutual buyer-follow. */
  static async isFriend(buyerIdA: string, buyerIdB: string): Promise<boolean> {
    const [ab, ba] = await Promise.all([
      Follow.exists({ followerId: buyerIdA, targetType: 'buyer', targetId: buyerIdB }),
      Follow.exists({ followerId: buyerIdB, targetType: 'buyer', targetId: buyerIdA }),
    ]);
    return Boolean(ab && ba);
  }

  static async followerCount(targetType: FollowTargetType, targetId: string): Promise<number> {
    return Follow.countDocuments({ targetType, targetId });
  }

  static async followingCount(buyerId: string): Promise<number> {
    return Follow.countDocuments({ followerId: buyerId });
  }

  static async followingIds(buyerId: string, targetType: FollowTargetType): Promise<string[]> {
    const rows = await Follow.find({ followerId: buyerId, targetType }).select('targetId');
    return rows.map((r) => String(r.targetId));
  }

  /** Buyers who follow this buyer. */
  static async followerIds(buyerId: string): Promise<string[]> {
    const rows = await Follow.find({ targetType: 'buyer', targetId: buyerId }).select('followerId');
    return rows.map((r) => String(r.followerId));
  }

  /** Mutuals: I follow them AND they follow me. */
  static async friendIds(buyerId: string): Promise<string[]> {
    const iFollow = await FollowService.followingIds(buyerId, 'buyer');
    if (iFollow.length === 0) return [];
    const back = await Follow.find({
      followerId: { $in: iFollow },
      targetType: 'buyer',
      targetId: buyerId,
    }).select('followerId');
    return back.map((r) => String(r.followerId));
  }

  /** Buyers following an organizer — announcement fan-out audience. */
  static async organizerFollowerIds(vendorId: string): Promise<string[]> {
    const rows = await Follow.find({ targetType: 'organizer', targetId: vendorId }).select('followerId');
    return rows.map((r) => String(r.followerId));
  }
}
