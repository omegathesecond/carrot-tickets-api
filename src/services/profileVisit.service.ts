import { Types } from 'mongoose';
import { ProfileVisit, ProfileVisitor } from '@models/profileVisit.model';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import type { SocialActor, SocialActorType } from '@utils/socialActor.util';

export class ProfileVisitService {
  static async visit(targetType: SocialActorType, targetId: string, browserId: string, actor: SocialActor | null) {
    if (!['buyer', 'vendor'].includes(targetType) || !HEX24.test(targetId)) {
      throw new HttpError(400, 'Invalid profile');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(browserId)) {
      throw new HttpError(400, 'A valid visitor ID is required');
    }
    targetId = targetId.toLowerCase();
    browserId = browserId.toLowerCase();
    const exists = targetType === 'buyer'
      ? await Buyer.exists({ _id: targetId })
      : await Vendor.exists({ _id: targetId, isActive: true, isSuperAdmin: { $ne: true } });
    if (!exists) throw new HttpError(404, 'Profile not found');

    // Never accept visits until the unique indexes are ready. init() is
    // shared by Mongoose, so subsequent requests await resolved promises.
    await Promise.all([ProfileVisit.init(), ProfileVisitor.init()]);
    const guestKey = `guest:${browserId}`;
    let visitorKey: string;
    if (actor) {
      visitorKey = `${actor.type}:${actor.id}`;
      // Resolve anonymous history once. A later account on a shared browser
      // records its own visits, but must never take ownership of earlier ones.
      try {
        await ProfileVisitor.updateOne({ guestKey }, { $setOnInsert: { actorKey: visitorKey } }, { upsert: true });
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
      }
    } else {
      const known = await ProfileVisitor.findOne({ guestKey }).lean();
      visitorKey = known?.actorKey ?? guestKey;
    }
    const target = { targetType, targetId };
    if (visitorKey !== `${targetType}:${targetId}`) {
      try {
        await ProfileVisit.updateOne({ ...target, visitorKey }, { $setOnInsert: { ...target, visitorKey } }, { upsert: true });
      } catch (error: any) {
        // A concurrent upsert may lose to the unique index; all other storage
        // failures must reach the normal API error channel.
        if (error?.code !== 11000) throw error;
      }
    }
    // Resolve guest identities at read time, rather than deleting guest rows:
    // a late anonymous request racing sign-in cannot re-inflate the count.
    // This also reconciles earlier guest visits across all profile targets.
    const ownKey = `${targetType}:${targetId}`;
    const counts = await ProfileVisit.aggregate<{ count: number }>([
      { $match: { targetType, targetId: new Types.ObjectId(targetId) } },
      { $lookup: { from: ProfileVisitor.collection.name, localField: 'visitorKey', foreignField: 'guestKey', as: 'identity' } },
      { $project: { key: { $ifNull: [{ $arrayElemAt: ['$identity.actorKey', 0] }, '$visitorKey'] } } },
      { $match: { key: { $ne: ownKey } } },
      { $group: { _id: '$key' } },
      { $count: 'count' },
    ]);
    return { profileViewCount: counts[0]?.count ?? 0 };
  }
}
