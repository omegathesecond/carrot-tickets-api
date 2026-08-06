import mongoose from 'mongoose';
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';

const PHONE = '+26878422613';

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

  it('page 2 is disjoint from page 1', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });

    const candidates = [];
    for (let i = 0; i < 6; i++) {
      const c = await Buyer.create({ phone: `+2687800005${i}`, password: 'secret1', name: `Cand${i}`, username: `cand_${i}` });
      await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: c._id });
      candidates.push(c);
    }

    const page1 = await request(app)
      .get('/api/social/suggestions/people?limit=2&page=1')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`)
      .expect(200);
    const page2 = await request(app)
      .get('/api/social/suggestions/people?limit=2&page=2')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`)
      .expect(200);

    expect(page1.body.data).toHaveLength(2);
    expect(page2.body.data).toHaveLength(2);
    const ids1 = page1.body.data.map((p: any) => p.id);
    const ids2 = page2.body.data.map((p: any) => p.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it('ranks a candidate sharing an event with the viewer above an equal-mutual candidate sharing none', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });

    // Deliberately seeded/followed in an order that does NOT match the
    // expected rank (noEvent first) — a naive insertion-order-stable sort
    // would keep noEvent ahead, so this only passes once event-overlap
    // actually reorders the tie.
    const noEvent = await Buyer.create({ phone: '+26878000032', password: 'secret1', name: 'NoEvent', username: 'no_event' });
    const sharesEvent = await Buyer.create({ phone: '+26878000031', password: 'secret1', name: 'SharesEvent', username: 'shares_event', });
    // Both are equal-mutual: only `friend` connects me to each of them.
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: noEvent._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: sharesEvent._id });

    const sharedEventId = new mongoose.Types.ObjectId();
    const vendorId = new mongoose.Types.ObjectId();
    // Me and sharesEvent both hold a live ticket to the same event; noEvent holds none.
    await Ticket.create({ eventId: sharedEventId, vendorId, ticketType: 'GA', price: 0, customerPhone: '+26878422613', status: TicketStatus.SOLD });
    await Ticket.create({ eventId: sharedEventId, vendorId, ticketType: 'GA', price: 0, customerPhone: '+26878000031', status: TicketStatus.SOLD });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const ids = res.body.data.map((p: any) => p.username);
    const sharesIndex = ids.indexOf('shares_event');
    const noEventIndex = ids.indexOf('no_event');
    expect(sharesIndex).toBeGreaterThanOrEqual(0);
    expect(noEventIndex).toBeGreaterThanOrEqual(0);
    expect(sharesIndex).toBeLessThan(noEventIndex);
  });

  it('breaks a same-mutual, same-event tie in favor of the buyer in the same city as the viewer', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one', city: 'Manzini' });
    const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: friend._id });

    // otherCity seeded/followed FIRST — a naive stable sort on tied
    // mutualCount would keep it ahead, so this only passes once same-city
    // actually breaks the tie in sameCity's favor.
    const otherCity = await Buyer.create({ phone: '+26878000042', password: 'secret1', name: 'OtherCity', username: 'other_city', city: 'Mbabane' });
    const sameCity = await Buyer.create({ phone: '+26878000041', password: 'secret1', name: 'SameCity', username: 'same_city', city: 'Manzini' });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: otherCity._id });
    await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: sameCity._id });

    const res = await request(app).get('/api/social/suggestions/people').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(200);
    const usernames = res.body.data.map((p: any) => p.username);
    expect(usernames.indexOf('same_city')).toBeLessThan(usernames.indexOf('other_city'));
  });

  it('with a seed, returns a deterministic order that changes with the seed (fallback pool)', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    for (let i = 0; i < 8; i++) {
      await Buyer.create({ phone: `+2687000000${i}`, password: 'secret1', name: `P${i}`, username: `pp${i}` });
    }
    const token = signBuyerToken(PHONE);
    const a1 = await request(app).get('/api/social/suggestions/people?seed=7').set('Authorization', `Bearer ${token}`).expect(200);
    const a2 = await request(app).get('/api/social/suggestions/people?seed=7').set('Authorization', `Bearer ${token}`).expect(200);
    const b = await request(app).get('/api/social/suggestions/people?seed=999').set('Authorization', `Bearer ${token}`).expect(200);
    expect(a1.body.data.map((p: any) => p.id)).toEqual(a2.body.data.map((p: any) => p.id));
    expect(a1.body.data.map((p: any) => p.id)).not.toEqual(b.body.data.map((p: any) => p.id));
  });

  it('with a fixed seed, paginates the fallback pool without overlap', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    for (let i = 0; i < 6; i++) {
      await Buyer.create({ phone: `+2687100000${i}`, password: 'secret1', name: `Q${i}`, username: `qq${i}` });
    }
    const token = signBuyerToken(PHONE);
    const p1 = await request(app).get('/api/social/suggestions/people?seed=42&limit=2&page=1').set('Authorization', `Bearer ${token}`).expect(200);
    const p2 = await request(app).get('/api/social/suggestions/people?seed=42&limit=2&page=2').set('Authorization', `Bearer ${token}`).expect(200);
    const ids1 = p1.body.data.map((p: any) => p.id);
    const ids2 = p2.body.data.map((p: any) => p.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });
});
