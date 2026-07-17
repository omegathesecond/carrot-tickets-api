import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';

let vseq = 0;
const makeVendor = (name?: string) => {
  vseq += 1;
  return Vendor.create({
    businessName: name ?? `Brand ${vseq}`,
    email: `vendor-profile-${vseq}@example.com`,
    phoneNumber: `+2687${8000100 + vseq}`,
    password: 'secret123',
  });
};

describe('GET /api/tickets/social/users/:username (vendor viewer)', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Follow.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('200s with the buyer public profile for a vendor token', async () => {
    const vendor = await makeVendor('Bhora Fest');
    const buyer = await Buyer.create({ phone: '+26878000301', name: 'Bo', password: 'secret1', username: 'bhora_bo' });
    const token = `Bearer ${signVendorToken(String(vendor._id))}`;

    const res = await request(app).get('/api/tickets/social/users/bhora_bo')
      .set('Authorization', token).expect(200);

    expect(res.body.data).toMatchObject({
      id: String(buyer._id),
      username: 'bhora_bo',
      name: 'Bo',
      followerCount: 0,
      followingCount: 0,
      eventsAttended: 0,
      isFollowing: false,
      isFollowedBy: false,
      isFriend: false,
      isBlocked: false,
    });
    expect(res.body.data).toHaveProperty('avatarUrl');
    expect(res.body.data).toHaveProperty('bio');
    expect(res.body.data).toHaveProperty('joinedAt');
    // NEVER expose the buyer's phone to the vendor viewer.
    expect(JSON.stringify(res.body.data)).not.toContain('+26878000301');
  });

  it('404s an unknown username', async () => {
    const vendor = await makeVendor();
    const token = `Bearer ${signVendorToken(String(vendor._id))}`;
    await request(app).get('/api/tickets/social/users/nobody_here')
      .set('Authorization', token).expect(404);
  });

  it('401s a buyer token (no vendorId)', async () => {
    await Buyer.create({ phone: '+26878000302', password: 'secret1', username: 'plain_buyer' });
    await request(app).get('/api/tickets/social/users/plain_buyer')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });

  it('isFollowing is true once this vendor follows the buyer, false after unfollow', async () => {
    const vendor = await makeVendor();
    const buyer = await Buyer.create({ phone: '+26878000303', name: 'Cee', password: 'secret1', username: 'cee_buyer' });
    const token = `Bearer ${signVendorToken(String(vendor._id))}`;

    const before = await request(app).get('/api/tickets/social/users/cee_buyer')
      .set('Authorization', token).expect(200);
    expect(before.body.data.isFollowing).toBe(false);

    await request(app).post('/api/tickets/social/follow').set('Authorization', token)
      .send({ targetType: 'buyer', targetId: String(buyer._id) }).expect(200);

    const after = await request(app).get('/api/tickets/social/users/cee_buyer')
      .set('Authorization', token).expect(200);
    expect(after.body.data.isFollowing).toBe(true);
    expect(after.body.data.followerCount).toBe(1);

    await request(app).delete(`/api/tickets/social/follow/buyer/${buyer._id}`).set('Authorization', token).expect(200);
    const afterUnfollow = await request(app).get('/api/tickets/social/users/cee_buyer')
      .set('Authorization', token).expect(200);
    expect(afterUnfollow.body.data.isFollowing).toBe(false);
  });

  it('isFollowedBy + isFriend reflect the buyer following the vendor brand back', async () => {
    const vendor = await makeVendor('Followed Brand');
    const buyer = await Buyer.create({ phone: '+26878000304', name: 'Dee', password: 'secret1', username: 'dee_buyer' });
    const vendorToken = `Bearer ${signVendorToken(String(vendor._id))}`;
    const buyerToken = `Bearer ${signBuyerToken('+26878000304')}`;

    // Vendor follows the buyer.
    await request(app).post('/api/tickets/social/follow').set('Authorization', vendorToken)
      .send({ targetType: 'buyer', targetId: String(buyer._id) }).expect(200);

    let profile = await request(app).get('/api/tickets/social/users/dee_buyer')
      .set('Authorization', vendorToken).expect(200);
    expect(profile.body.data.isFollowedBy).toBe(false);
    expect(profile.body.data.isFriend).toBe(false);

    // Buyer follows the vendor's brand back (organizer target).
    await request(app).post('/api/social/follow').set('Authorization', buyerToken)
      .send({ targetType: 'organizer', targetId: String(vendor._id) }).expect(200);

    profile = await request(app).get('/api/tickets/social/users/dee_buyer')
      .set('Authorization', vendorToken).expect(200);
    expect(profile.body.data.isFollowedBy).toBe(true);
    expect(profile.body.data.isFriend).toBe(true);
  });
});
