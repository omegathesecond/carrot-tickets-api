import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';
import { Follow } from '@models/follow.model';

// Seed real buyer targets so allowed browsing exercises the onboarding middleware.
export async function seedBuyerFollows(followerType: 'buyer' | 'vendor', followerId: string, count = 10) {
  const buyers = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const phone = `+268781000${String(i).padStart(2, '0')}`;
    return await Buyer.findOne({ phone }) ?? Buyer.create({
      phone, password: 'secret1', name: `Followed buyer ${i}`, username: `followed_buyer_${i}`,
    });
  }));
  await Follow.insertMany(buyers.map((buyer) => ({
    followerType, followerId, targetType: 'buyer', targetId: buyer._id,
  })));
}

// Ready uploads qualify profile reads without granting browse access.
export async function seedReadyMedia(authorType: 'buyer' | 'vendor', authorId: string, count = 3) {
  await Update.create({
    authorType, authorId, kind: 'image',
    media: Array.from({ length: count }, (_, i) => ({
      rawKey: `onboarding-${i}`, status: 'ready',
      image: { url: `https://cdn.carrottickets.com/test/onboarding-${i}.jpg`, width: 1, height: 1 },
    })),
  });
}
