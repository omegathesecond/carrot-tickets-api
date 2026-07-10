import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Follow } from '@models/follow.model';
import { FollowService } from '@services/follow.service';
import { HttpError } from '@utils/httpError.util';

describe('FollowService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Follow.init(); // unique index must exist before idempotency tests race it
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedBuyer(phone: string): Promise<IBuyer> {
    return Buyer.create({ phone, password: 'secret1', name: `B${phone.slice(-4)}` });
  }

  it('follow/unfollow a buyer is idempotent and counted', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');

    await FollowService.follow(a, 'buyer', String(b._id));
    await FollowService.follow(a, 'buyer', String(b._id)); // idempotent

    expect(await FollowService.followerCount('buyer', String(b._id))).toBe(1);
    expect(await FollowService.followingCount(String(a._id))).toBe(1);

    await FollowService.unfollow(a, 'buyer', String(b._id));
    await FollowService.unfollow(a, 'buyer', String(b._id)); // idempotent
    expect(await FollowService.followerCount('buyer', String(b._id))).toBe(0);
  });

  it('mutual buyer-follow = friends', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');

    await FollowService.follow(a, 'buyer', String(b._id));
    expect(await FollowService.isFriend(String(a._id), String(b._id))).toBe(false);

    await FollowService.follow(b, 'buyer', String(a._id));
    expect(await FollowService.isFriend(String(a._id), String(b._id))).toBe(true);
    expect(await FollowService.friendIds(String(a._id))).toEqual([String(b._id)]);
  });

  it('can follow an organizer (Vendor)', async () => {
    const a = await seedBuyer('+26878000001');
    const vendor = await Vendor.create({
      businessName: 'Piano Republic Events',
      email: 'org@example.com',
      password: 'secret123',
      phoneNumber: '+26878000099',
    });

    await FollowService.follow(a, 'organizer', String(vendor._id));
    expect(await FollowService.followerCount('organizer', String(vendor._id))).toBe(1);
    expect(await FollowService.followingIds(String(a._id), 'organizer')).toEqual([String(vendor._id)]);
  });

  it('rejects self-follow (400) and missing target (404)', async () => {
    const a = await seedBuyer('+26878000001');
    await expect(FollowService.follow(a, 'buyer', String(a._id))).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      FollowService.follow(a, 'buyer', String(new mongoose.Types.ObjectId()))
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      FollowService.follow(a, 'organizer', String(new mongoose.Types.ObjectId()))
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(HttpError).toBeDefined();
  });
});
