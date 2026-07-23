import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';

describe('GET /api/social/suggestions/people', () => {
  beforeAll(async () => { await connectTestDb(); await Follow.init(); });
  afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('surfaces friends-of-friends I do not already follow, ranked by mutual count', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    const suggestion = await Buyer.create({ phone: '+26878000022', password: 'secret1', name: 'Suggested', username: 'sugg_b' });
    // me -> friend, friend -> suggestion
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: suggestion._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const usernames = res.body.data.map((p: any) => p.username);
    expect(usernames).toContain('sugg_b');
    expect(usernames).not.toContain('friend_a'); // already followed
    expect(usernames).not.toContain('me_one');   // never suggest self
  });

  it('shapes the DTO correctly and marks suggestions as not-followed', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    const suggestion = await Buyer.create({
      phone: '+26878000022', password: 'secret1', name: 'Suggested', username: 'sugg_b',
      avatarUrl: 'https://cdn.example.com/a.png', bio: 'hello there',
    });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: suggestion._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const row = res.body.data.find((p: any) => p.username === 'sugg_b');
    expect(row).toEqual({
      id: String(suggestion._id),
      name: 'Suggested',
      username: 'sugg_b',
      avatarUrl: 'https://cdn.example.com/a.png',
      bio: 'hello there',
      city: null,
      mutualCount: 1,
      isFollowing: false,
    });
  });

  it('ranks candidates with more shared connections higher', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friendA = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'FriendA', username: 'friend_a' });
    const friendB = await Buyer.create({ phone: '+26878000023', password: 'secret1', name: 'FriendB', username: 'friend_c' });
    const popular = await Buyer.create({ phone: '+26878000022', password: 'secret1', name: 'Popular', username: 'popular_b' });
    const lonely = await Buyer.create({ phone: '+26878000024', password: 'secret1', name: 'Lonely', username: 'lonely_d' });

    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friendA._id });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friendB._id });
    // Both friends follow `popular`; only friendA follows `lonely`.
    await Follow.create({ followerType: 'buyer', followerId: friendA._id, targetType: 'buyer', targetId: popular._id });
    await Follow.create({ followerType: 'buyer', followerId: friendB._id, targetType: 'buyer', targetId: popular._id });
    await Follow.create({ followerType: 'buyer', followerId: friendA._id, targetType: 'buyer', targetId: lonely._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const popularRow = res.body.data.find((p: any) => p.username === 'popular_b');
    const lonelyRow = res.body.data.find((p: any) => p.username === 'lonely_d');
    expect(popularRow.mutualCount).toBe(2);
    expect(lonelyRow.mutualCount).toBe(1);
    const popularIndex = res.body.data.findIndex((p: any) => p.username === 'popular_b');
    const lonelyIndex = res.body.data.findIndex((p: any) => p.username === 'lonely_d');
    expect(popularIndex).toBeLessThan(lonelyIndex);
  });

  it('excludes buyers who are socially suspended', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    const suspended = await Buyer.create({
      phone: '+26878000022', password: 'secret1', name: 'Suspended', username: 'sus_b', socialSuspendedAt: new Date(),
    });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: suspended._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const usernames = res.body.data.map((p: any) => p.username);
    expect(usernames).not.toContain('sus_b');
  });

  it('excludes second-degree candidates with no username (unlinkable in the UI)', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    const noUsername = await Buyer.create({ phone: '+26878000022', password: 'secret1', name: 'NoHandle' });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: noUsername._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const ids = res.body.data.map((p: any) => p.id);
    expect(ids).not.toContain(String(noUsername._id));
  });

  it('falls back to recently-active handled buyers when the buyer follows no one, with mutualCount 0', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const other = await Buyer.create({
      phone: '+26878000021', password: 'secret1', name: 'Other', username: 'other_a', lastLoginAt: new Date(),
    });
    const noUsername = await Buyer.create({ phone: '+26878000099', password: 'secret1', name: 'NoHandle' });
    void noUsername;

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const row = res.body.data.find((p: any) => p.username === 'other_a');
    expect(row).toBeTruthy();
    expect(row.mutualCount).toBe(0);
    const usernames = res.body.data.map((p: any) => p.username);
    expect(usernames).not.toContain(undefined);
    expect(usernames).not.toContain(null);
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/suggestions/people').expect(401);
  });
});
