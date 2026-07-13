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

  // add near seedBuyer, still inside describe('FollowService', …)
  let vseq = 0;
  const makeVendor = () => {
    vseq += 1;
    return Vendor.create({
      businessName: `Brand ${vseq}`,
      email: `vendor${vseq}@example.com`,
      phoneNumber: `+2687${8000000 + vseq}`,
      password: 'secret123',
    });
  };

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

  it('a vendor follows a buyer and an organizer; counts + edges are scoped to the vendor', async () => {
    const vendor = await makeVendor();
    const buyer = await seedBuyer('+26878000101');
    const otherVendor = await makeVendor();

    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    await FollowService.followAsVendor(String(vendor._id), 'organizer', String(otherVendor._id));

    expect(await FollowService.followingCount(String(vendor._id), 'vendor')).toBe(2);
    expect(await FollowService.followingCount(String(vendor._id), 'buyer')).toBe(0); // no buyer-typed edges for this id
    expect(await FollowService.followingIds(String(vendor._id), 'organizer', 'vendor')).toEqual([String(otherVendor._id)]);

    const edge = await Follow.findOne({ followerType: 'vendor', followerId: vendor._id, targetType: 'buyer' });
    expect(edge).toBeTruthy();
  });

  it('followAsVendor is idempotent and 404s an unknown target', async () => {
    const vendor = await makeVendor();
    const buyer = await seedBuyer('+26878000102');
    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id)); // no throw
    expect(await FollowService.followingCount(String(vendor._id), 'vendor')).toBe(1);

    await expect(
      FollowService.followAsVendor(String(vendor._id), 'buyer', String(new mongoose.Types.ObjectId()))
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a vendor cannot follow itself', async () => {
    const vendor = await makeVendor();
    await expect(
      FollowService.followAsVendor(String(vendor._id), 'organizer', String(vendor._id))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('unfollowAsVendor removes only the vendor edge', async () => {
    const vendor = await makeVendor();
    const buyer = await seedBuyer('+26878000103');
    await FollowService.followAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    await FollowService.unfollowAsVendor(String(vendor._id), 'buyer', String(buyer._id));
    expect(await FollowService.followingCount(String(vendor._id), 'vendor')).toBe(0);
  });
});
