import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { CommunityService } from '@services/community.service';
import { Channel } from '@models/channel.model';
import { Membership } from '@models/membership.model';
import { resetBuckets } from '@utils/rateLimit.util';

const PHONE = '+26878422613';

async function seedWorld() {
  const seeded = await seedPublishedEvent();
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  const channels = await Channel.find({ communityId: community._id });
  const bySlug = Object.fromEntries(channels.map((c) => [c.slug, c]));
  await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Chatty Buyer' });
  const auth = `Bearer ${signBuyerToken(PHONE)}`;
  return { seeded, community, bySlug, auth };
}

describe('community message routes', () => {
  beforeAll(connectTestDb);
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('member can post to #general and read it back, newest first', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);

    const general = String(bySlug['general']!._id);
    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'first!' })
      .expect(201);
    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'second!' })
      .expect(201);

    const res = await request(app)
      .get(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .expect(200);

    const messages = res.body.data;
    expect(messages).toHaveLength(2);
    expect(messages[0].body).toBe('second!'); // newest first
    expect(messages[1].body).toBe('first!');
    expect(messages[0].sender.username).toBeTruthy();
  });

  it('cursor pagination with before', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    resetBuckets();
    await request(app).post(`/api/community/channels/${general}/messages`).set('Authorization', auth).send({ body: 'm1' }).expect(201);
    await request(app).post(`/api/community/channels/${general}/messages`).set('Authorization', auth).send({ body: 'm2' }).expect(201);
    await request(app).post(`/api/community/channels/${general}/messages`).set('Authorization', auth).send({ body: 'm3' }).expect(201);

    const page1 = await request(app)
      .get(`/api/community/channels/${general}/messages?limit=2`)
      .set('Authorization', auth)
      .expect(200);
    expect(page1.body.data.map((m: any) => m.body)).toEqual(['m3', 'm2']);

    const cursor = page1.body.data[1].id;
    const page2 = await request(app)
      .get(`/api/community/channels/${general}/messages?limit=2&before=${cursor}`)
      .set('Authorization', auth)
      .expect(200);
    expect(page2.body.data.map((m: any) => m.body)).toEqual(['m1']);
  });

  it('non-member cannot read or post', async () => {
    const { bySlug, auth } = await seedWorld(); // seeded but never joined
    const general = String(bySlug['general']!._id);
    await request(app).get(`/api/community/channels/${general}/messages`).set('Authorization', auth).expect(403);
    await request(app).post(`/api/community/channels/${general}/messages`).set('Authorization', auth).send({ body: 'hi' }).expect(403);
  });

  it('gated channel: 403 without ticket, 200 with (auto re-verify)', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const attendees = String(bySlug['attendees']!._id);

    await request(app).get(`/api/community/channels/${attendees}/messages`).set('Authorization', auth).expect(403);

    await Ticket.create({
      eventId: seeded.eventId, vendorId: seeded.vendorId, ticketType: 'General',
      price: 100, customerPhone: PHONE, status: TicketStatus.SOLD,
    });

    // No explicit verify-ticket call — access check re-verifies on demand.
    await request(app).get(`/api/community/channels/${attendees}/messages`).set('Authorization', auth).expect(200);
  });

  it('buyers cannot post in #announcements (organizer-only)', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const ann = String(bySlug['announcements']!._id);
    await request(app)
      .post(`/api/community/channels/${ann}/messages`)
      .set('Authorization', auth)
      .send({ body: 'hijack!' })
      .expect(403);
  });

  it('rate limit: 6th rapid message is 429', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    resetBuckets();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', auth)
        .send({ body: `msg ${i}` })
        .expect(201);
    }
    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'too fast' })
      .expect(429);
  });

  it('sender can soft-delete own message; body is masked in history', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    const sent = await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'regret this' })
      .expect(201);

    await request(app)
      .delete(`/api/community/messages/${sent.body.data.id}`)
      .set('Authorization', auth)
      .expect(200);

    const res = await request(app)
      .get(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.data[0].deleted).toBe(true);
    expect(res.body.data[0].body).toBe('');
  });

  it('cannot delete someone else\'s message', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    const sent = await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'mine' })
      .expect(201);

    const OTHER = '+26878000099';
    await Buyer.create({ phone: OTHER, password: 'secret1' });
    const otherAuth = `Bearer ${signBuyerToken(OTHER)}`;
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', otherAuth).expect(200);

    await request(app)
      .delete(`/api/community/messages/${sent.body.data.id}`)
      .set('Authorization', otherAuth)
      .expect(403);
  });

  it('rejects an empty or oversized body', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: '' })
      .expect(400);
    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'x'.repeat(2001) })
      .expect(400);
  });

  it('banned member is blocked everywhere: read, post, and delete-own', async () => {
    const { seeded, community, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    const sent = await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'pre-ban message' })
      .expect(201);

    const buyer = await Buyer.findOne({ phone: PHONE });
    await Membership.updateOne(
      { buyerId: buyer!._id, communityId: community._id },
      { bannedAt: new Date() }
    );

    await request(app).get(`/api/community/channels/${general}/messages`).set('Authorization', auth).expect(403);
    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'post-ban' })
      .expect(403);
    await request(app)
      .delete(`/api/community/messages/${sent.body.data.id}`)
      .set('Authorization', auth)
      .expect(403);
  });

  it('muted member can read but not post', async () => {
    const { seeded, community, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    const buyer = await Buyer.findOne({ phone: PHONE });
    await Membership.updateOne(
      { buyerId: buyer!._id, communityId: community._id },
      { mutedUntil: new Date(Date.now() + 60 * 60 * 1000) }
    );

    await request(app).get(`/api/community/channels/${general}/messages`).set('Authorization', auth).expect(200);
    await request(app)
      .post(`/api/community/channels/${general}/messages`)
      .set('Authorization', auth)
      .send({ body: 'muted!' })
      .expect(403);
  });

  it('rejects malformed limit and before with 400 (never unbounded)', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    await request(app)
      .get(`/api/community/channels/${general}/messages?limit=abc`)
      .set('Authorization', auth)
      .expect(400);
    await request(app)
      .get(`/api/community/channels/${general}/messages?limit=1&limit=2`)
      .set('Authorization', auth)
      .expect(400);
    await request(app)
      .get(`/api/community/channels/${general}/messages?limit=0`)
      .set('Authorization', auth)
      .expect(400);
    await request(app)
      .get(`/api/community/channels/${general}/messages?before=not-an-id`)
      .set('Authorization', auth)
      .expect(400);
  });
});
