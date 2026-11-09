import mongoose from 'mongoose';
import { Follow } from '@models/follow.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';
import type { SocialActor } from '@utils/socialActor.util';

export class OnboardingService {
  static async status(actor: SocialActor) {
    const [followingCount, media, buyer, vendor] = await Promise.all([
      Follow.countDocuments({ followerType: actor.type, followerId: actor.id, targetType: 'buyer' }),
      Update.aggregate<{ count: number }>([
        { $match: { authorType: actor.type, authorId: new mongoose.Types.ObjectId(actor.id), status: 'active' } },
        { $unwind: '$media' },
        { $match: { 'media.status': 'ready', $or: [{ 'media.image.url': { $exists: true } }, { 'media.video.url': { $exists: true } }] } },
        { $count: 'count' },
      ]),
      actor.type === 'buyer' ? Buyer.findById(actor.id).select('username avatarUrl').lean() : Promise.resolve(null),
      actor.type === 'vendor' ? Vendor.findById(actor.id).select('logoUrl').lean() : Promise.resolve(null),
    ]);
    const mediaCount = media[0]?.count ?? 0;
    return { hasProfilePhoto: Boolean(buyer?.avatarUrl || vendor?.logoUrl), actorId: actor.id, actorType: actor.type, username: buyer?.username ?? null, followingCount, mediaCount, canBrowse: followingCount >= 10, canViewProfiles: mediaCount >= 3 };
  }
}
