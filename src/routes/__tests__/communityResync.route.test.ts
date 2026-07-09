import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';

const PHONE = '+26878422613';

async function seedWorld() {
  const seeded = await seedPublishedEvent();
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  const channels = await Channel.find({ communityId: community._id });
  const bySlug = Object.fromEntries(channels.map((c) => [c.slug, c]));
  await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Resync Buyer' });
  const auth = `Bearer ${signBuyerToken(PHONE)}`;
  return { seeded, community, bySlug, auth };
}

async function post(auth: string, channelId: string, body: string) {
  const res = await request(app)
    .post(`/api/community/channels/${channelId}/messages`)
    .set('Authorization', auth)
    .send({ body })
    .expect(201);
  return res.body.data;
}

describe('resync, read-state and unread badges', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('after=<id> returns newer messages in ASCENDING order', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    const m1 = await post(auth, general, 'm1');
    await post(auth, general, 'm2');
    await post(auth, general, 'm3');

    const res = await request(app)
      .get(`/api/community/channels/${general}/messages?after=${m1.id}`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.data.map((m: any) => m.body)).toEqual(['m2', 'm3']);
  });

  it('before + after together is 400; malformed after is 400', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);
    const m1 = await post(auth, general, 'm1');

    await request(app)
      .get(`/api/community/channels/${general}/messages?after=${m1.id}&before=${m1.id}`)
      .set('Authorization', auth)
      .expect(400);
    await request(app)
      .get(`/api/community/channels/${general}/messages?after=garbage`)
      .set('Authorization', auth)
      .expect(400);
  });

  it('unreadCount appears for members, resets on read, null when locked', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    await post(auth, general, 'unread 1');
    await post(auth, general, 'unread 2');

    let view = await request(app).get(`/api/community/${seeded.eventId}`).set('Authorization', auth).expect(200);
    let channels = Object.fromEntries(view.body.data.channels.map((c: any) => [c.slug, c]));
    expect(channels['general'].unreadCount).toBe(2);
    expect(channels['attendees'].unreadCount).toBeNull(); // locked (no ticket)

    await request(app)
      .post(`/api/community/channels/${general}/read`)
      .set('Authorization', auth)
      .expect(200);

    view = await request(app).get(`/api/community/${seeded.eventId}`).set('Authorization', auth).expect(200);
    channels = Object.fromEntries(view.body.data.channels.map((c: any) => [c.slug, c]));
    expect(channels['general'].unreadCount).toBe(0);
  });

  it('read endpoint enforces channel access (non-member 403)', async () => {
    const { bySlug } = await seedWorld(); // buyer never joins
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    await request(app)
      .post(`/api/community/channels/${String(bySlug['general']!._id)}/read`)
      .set('Authorization', auth)
      .expect(403);
  });

  it('mark-read with uppercase-hex channelId still clears the badge', async () => {
    const { seeded, bySlug, auth } = await seedWorld();
    await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', auth).expect(200);
    const general = String(bySlug['general']!._id);

    await post(auth, general, 'unread');

    await request(app)
      .post(`/api/community/channels/${general.toUpperCase()}/read`)
      .set('Authorization', auth)
      .expect(200);

    const view = await request(app).get(`/api/community/${seeded.eventId}`).set('Authorization', auth).expect(200);
    const channels = Object.fromEntries(view.body.data.channels.map((c: any) => [c.slug, c]));
    expect(channels['general'].unreadCount).toBe(0);
  });
});
