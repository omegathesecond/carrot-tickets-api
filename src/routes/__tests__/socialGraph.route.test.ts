import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { CommunityService } from '@services/community.service';
import { Membership } from '@models/membership.model';
import { Block } from '@models/block.model';
import { Follow } from '@models/follow.model';

const PHONE_A = '+26878422613';
const PHONE_B = '+26878000042';
const PHONE_C = '+26878000043';

async function seedBuyers() {
  const a = await Buyer.create({ phone: PHONE_A, password: 'secret1', name: 'Alpha', username: 'alpha_one' });
  const b = await Buyer.create({ phone: PHONE_B, password: 'secret1', name: 'Beta', username: 'beta_two' });
  const c = await Buyer.create({ phone: PHONE_C, password: 'secret1', name: 'Gamma', username: 'gamma_three' });
  return { a, b, c, authA: `Bearer ${signBuyerToken(PHONE_A)}`, authB: `Bearer ${signBuyerToken(PHONE_B)}` };
}

describe('social graph routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Block.init(); // unique index must exist before block/follow interactions race it
    await Follow.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('follow -> counts + viewer flags on public profile; mutual = friends', async () => {
    const { a, b, authA, authB } = await seedBuyers();

    await request(app).post('/api/social/follow').set('Authorization', authA)
      .send({ targetType: 'buyer', targetId: String(b._id) }).expect(200);

    let profile = await request(app).get('/api/social/users/beta_two').set('Authorization', authA).expect(200);
    expect(profile.body.data.followerCount).toBe(1);
    expect(profile.body.data.isFollowing).toBe(true);
    expect(profile.body.data.isFriend).toBe(false);
    expect(JSON.stringify(profile.body.data)).not.toContain(PHONE_B);

    await request(app).post('/api/social/follow').set('Authorization', authB)
      .send({ targetType: 'buyer', targetId: String(a._id) }).expect(200);

    profile = await request(app).get('/api/social/users/beta_two').set('Authorization', authA).expect(200);
    expect(profile.body.data.isFriend).toBe(true);
    expect(profile.body.data.isFollowedBy).toBe(true);

    const friends = await request(app).get('/api/social/me/friends').set('Authorization', authA).expect(200);
    expect(friends.body.data.map((u: any) => u.username)).toEqual(['beta_two']);

    await request(app).delete(`/api/social/follow/buyer/${String(b._id)}`).set('Authorization', authA).expect(200);
    const after = await request(app).get('/api/social/users/beta_two').set('Authorization', authA).expect(200);
    expect(after.body.data.isFollowing).toBe(false);
  });

  it('me gains counts and eventsAttended (distinct CHECKED_IN events)', async () => {
    const { authA } = await seedBuyers();
    const e1 = await seedPublishedEvent();
    const e2 = await seedPublishedEvent();
    for (const e of [e1, e2]) {
      await Ticket.create({
        eventId: e.eventId, vendorId: e.vendorId, ticketType: 'General', price: 100,
        customerPhone: PHONE_A, status: TicketStatus.CHECKED_IN,
      });
    }
    // second ticket for the same event must NOT double-count
    await Ticket.create({
      eventId: e1.eventId, vendorId: e1.vendorId, ticketType: 'VIP', price: 200,
      customerPhone: PHONE_A, status: TicketStatus.CHECKED_IN,
    });

    const me = await request(app).get('/api/social/me').set('Authorization', authA).expect(200);
    expect(me.body.data.eventsAttended).toBe(2);
    expect(me.body.data.followerCount).toBe(0);
    expect(me.body.data.friendCount).toBe(0);
  });

  it('user search matches username prefix, excludes self and blocked (either way)', async () => {
    const { b, authA, authB } = await seedBuyers();
    // C blocks nobody; B blocks A -> A's search must not show B
    await request(app).post('/api/social/block').set('Authorization', authB)
      .send({ userId: String((await Buyer.findOne({ phone: PHONE_A }))!._id) }).expect(200);

    const res = await request(app).get('/api/social/users/search?q=a').set('Authorization', authA).expect(400); // too short
    void res;
    const hits = await request(app).get('/api/social/users/search?q=be').set('Authorization', authA).expect(200);
    expect(hits.body.data.map((u: any) => u.username)).toEqual([]); // beta blocked A

    const hits2 = await request(app).get('/api/social/users/search?q=ga').set('Authorization', authA).expect(200);
    expect(hits2.body.data.map((u: any) => u.username)).toEqual(['gamma_three']);
    expect(JSON.stringify(hits2.body.data)).not.toContain(PHONE_C);
    void b;
  });

  it('community members list: member-only, excludes banned, newest first', async () => {
    const { a, b, c, authA, authB } = await seedBuyers();
    const seeded = await seedPublishedEvent();
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    await Membership.create({ buyerId: a._id, communityId: community._id });
    await Membership.create({ buyerId: b._id, communityId: community._id });
    await Membership.create({ buyerId: c._id, communityId: community._id, bannedAt: new Date() });

    const members = await request(app)
      .get(`/api/community/${seeded.eventId}/members`).set('Authorization', authA).expect(200);
    expect(members.body.data.map((u: any) => u.username)).toEqual(['beta_two', 'alpha_one']); // newest first, no banned gamma

    const page1 = await request(app)
      .get(`/api/community/${seeded.eventId}/members?limit=1`).set('Authorization', authA).expect(200);
    expect(page1.body.data).toHaveLength(1);
    const page2 = await request(app)
      .get(`/api/community/${seeded.eventId}/members?limit=1&before=${page1.body.data[0].cursor}`)
      .set('Authorization', authA).expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].username).not.toBe(page1.body.data[0].username);

    // non-member (fresh buyer) is refused
    await Buyer.create({ phone: '+26878000044', password: 'secret1' });
    await request(app)
      .get(`/api/community/${seeded.eventId}/members`)
      .set('Authorization', `Bearer ${signBuyerToken('+26878000044')}`)
      .expect(403);
    void authB;
  });
});
