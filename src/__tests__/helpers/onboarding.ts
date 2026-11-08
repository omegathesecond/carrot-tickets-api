import { Buyer } from '@models/buyer.model';
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

