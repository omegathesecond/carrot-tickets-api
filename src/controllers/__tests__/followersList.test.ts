import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Follow } from '@models/follow.model';

const ME_PHONE = '+26878422613';
const auth = (phone: string) => ({ Authorization: `Bearer ${signBuyerToken(phone)}` });

describe('GET /api/social/followers/:targetType/:targetId and /api/social/following/:targetType/:targetId', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Follow.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists the followers of a buyer target, with isFollowing resolved for the viewer', async () => {
    const me = await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Target', username: 'target_a' });
    const followerA = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'FollowerA', username: 'follower_a' });
    const followerB = await Buyer.create({ phone: '+26878000003', password: 'secret1', name: 'FollowerB', username: 'follower_b' });

    // followerA and followerB both follow target.
    await Follow.create({ followerType: 'buyer', followerId: followerA._id, targetType: 'buyer', targetId: target._id });
    await Follow.create({ followerType: 'buyer', followerId: followerB._id, targetType: 'buyer', targetId: target._id });
    // The viewer (me) already follows followerA, not followerB.
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: followerA._id });

    const res = await request(app)
      .get(`/api/social/followers/buyer/${target._id}`)
      .set(auth(ME_PHONE))
      .expect(200);

    const rows = res.body.data;
    expect(rows).toHaveLength(2);
    const byId = (id: string) => rows.find((r: any) => r.id === id);
    const rowA = byId(String(followerA._id));
    const rowB = byId(String(followerB._id));
    expect(rowA).toEqual({
      id: String(followerA._id),
      type: 'buyer',
      username: 'follower_a',
      name: 'FollowerA',
      avatarUrl: null,
      isFollowing: true,
    });
    expect(rowB).toEqual({
      id: String(followerB._id),
      type: 'buyer',
      username: 'follower_b',
      name: 'FollowerB',
      avatarUrl: null,
      isFollowing: false,
    });
  });

  it('lists who a buyer target follows (following list)', async () => {
    await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Target', username: 'target_a' });
    const followed = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'Followed', username: 'followed_a' });

    await Follow.create({ followerType: 'buyer', followerId: target._id, targetType: 'buyer', targetId: followed._id });

    const res = await request(app)
      .get(`/api/social/following/buyer/${target._id}`)
      .set(auth(ME_PHONE))
      .expect(200);

    const rows = res.body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: String(followed._id),
      type: 'buyer',
      username: 'followed_a',
      name: 'Followed',
      avatarUrl: null,
      isFollowing: false,
    });
  });

  it('shapes organizer (vendor) rows using businessName/slug/logoUrl as name/username/avatarUrl', async () => {
    await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const org = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret1', isActive: true, logoUrl: 'https://cdn.example.com/logo.png' });
    const followerBuyer = await Buyer.create({ phone: '+26878000004', password: 'secret1', name: 'Fan', username: 'fan_a' });
    await Follow.create({ followerType: 'buyer', followerId: followerBuyer._id, targetType: 'organizer', targetId: org._id });

    const res = await request(app)
      .get(`/api/social/followers/organizer/${org._id}`)
      .set(auth(ME_PHONE))
      .expect(200);

    expect(res.body.data).toEqual([
      { id: String(followerBuyer._id), type: 'buyer', username: 'fan_a', name: 'Fan', avatarUrl: null, isFollowing: false },
    ]);
  });

  it('an organizer target following list includes brands and buyers it follows, vendor-shaped rows using slug/businessName/logoUrl', async () => {
    await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const org = await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret1', isActive: true });
    const followedOrg = await Vendor.create({ businessName: 'House on Fire', password: 'secret1', isActive: true, logoUrl: 'https://cdn.example.com/hof.png' });
    await Follow.create({ followerType: 'vendor', followerId: org._id, targetType: 'organizer', targetId: followedOrg._id });

    const res = await request(app)
      .get(`/api/social/following/organizer/${org._id}`)
      .set(auth(ME_PHONE))
      .expect(200);

    expect(res.body.data).toEqual([
      { id: String(followedOrg._id), type: 'organizer', username: followedOrg.slug, name: 'House on Fire', avatarUrl: 'https://cdn.example.com/hof.png', isFollowing: false },
    ]);
  });

  it('supports limit/page pagination, most-recent follow first', async () => {
    await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Target', username: 'target_a' });
    const followers = [];
    for (let i = 0; i < 5; i++) {
      const f = await Buyer.create({ phone: `+2687800001${i}`, password: 'secret1', name: `F${i}`, username: `f_${i}` });
      await Follow.create({ followerType: 'buyer', followerId: f._id, targetType: 'buyer', targetId: target._id });
      followers.push(f);
    }

    const page1 = await request(app)
      .get(`/api/social/followers/buyer/${target._id}?limit=2&page=1`)
      .set(auth(ME_PHONE))
      .expect(200);
    const page2 = await request(app)
      .get(`/api/social/followers/buyer/${target._id}?limit=2&page=2`)
      .set(auth(ME_PHONE))
      .expect(200);

    expect(page1.body.data).toHaveLength(2);
    expect(page2.body.data).toHaveLength(2);
    const page1Ids = page1.body.data.map((r: any) => r.id);
    const page2Ids = page2.body.data.map((r: any) => r.id);
    expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toHaveLength(0);
  });

  it('rejects an invalid targetType with 400', async () => {
    await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    await request(app)
      .get('/api/social/followers/nonsense/507f1f77bcf86cd799439011')
      .set(auth(ME_PHONE))
      .expect(400);
  });

  it('anonymous callers get the followers/following lists too (public social data), isFollowing false', async () => {
    const target = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Target', username: 'target_a' });
    const follower = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'FollowerA', username: 'follower_a' });
    const followed = await Buyer.create({ phone: '+26878000003', password: 'secret1', name: 'Followed', username: 'followed_a' });
    await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: target._id });
    await Follow.create({ followerType: 'buyer', followerId: target._id, targetType: 'buyer', targetId: followed._id });

    const followersRes = await request(app).get(`/api/social/followers/buyer/${target._id}`).expect(200);
    expect(followersRes.body.data).toEqual([
      { id: String(follower._id), type: 'buyer', username: 'follower_a', name: 'FollowerA', avatarUrl: null, isFollowing: false },
    ]);

    const followingRes = await request(app).get(`/api/social/following/buyer/${target._id}`).expect(200);
    expect(followingRes.body.data).toEqual([
      { id: String(followed._id), type: 'buyer', username: 'followed_a', name: 'Followed', avatarUrl: null, isFollowing: false },
    ]);
  });

  it('a vendor session (organizer viewing their own brand profile) gets the list too, isFollowing false', async () => {
    const target = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Target', username: 'target_a' });
    const follower = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'FollowerA', username: 'follower_a' });
    await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: target._id });

    const res = await request(app)
      .get(`/api/social/followers/buyer/${target._id}`)
      .set({ Authorization: `Bearer ${signVendorToken('507f1f77bcf86cd799439012')}` })
      .expect(200);
    expect(res.body.data).toEqual([
      { id: String(follower._id), type: 'buyer', username: 'follower_a', name: 'FollowerA', avatarUrl: null, isFollowing: false },
    ]);
  });

  it('a buyer viewer still gets isFollowing resolved (regression guard for the public-read change)', async () => {
    const me = await Buyer.create({ phone: ME_PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: '+26878000001', password: 'secret1', name: 'Target', username: 'target_a' });
    const follower = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'FollowerA', username: 'follower_a' });
    await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: target._id });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: follower._id });

    const res = await request(app)
      .get(`/api/social/followers/buyer/${target._id}`)
      .set(auth(ME_PHONE))
      .expect(200);
    expect(res.body.data).toEqual([
      { id: String(follower._id), type: 'buyer', username: 'follower_a', name: 'FollowerA', avatarUrl: null, isFollowing: true },
    ]);
  });
});
