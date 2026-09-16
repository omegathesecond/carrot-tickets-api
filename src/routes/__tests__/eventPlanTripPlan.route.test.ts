import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';
import { EventPlanMember } from '@models/eventPlanMember.model';
import { EventPlanMessage } from '@models/eventPlanMessage.model';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined) }));

const auth = (phone: string) => ({ Authorization: `Bearer ${signBuyerToken(phone)}` });
const ADMIN = '+26878422613';
const FRIEND = '+26878000001';
const AVATAR = 'https://cdn.carrottickets.com/test/avatar.jpg';

async function makeEvent(overrides: Partial<any> = {}) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Test Event',
    venue: 'Test Venue',
    eventDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    startTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 3600_000),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
    ...overrides,
  });
}

async function makeBuyer(phone: string, name: string, username: string) {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: AVATAR, name, username });
}

function createPlan(phone: string, body: Record<string, unknown>) {
  return request(app).post('/api/social/plans').set(auth(phone)).send(body);
}

describe('Trip Plan — manually-entered events', () => {
  beforeAll(async () => {
    await connectTestDb();
    await EventPlan.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a plan from a manually-entered trip, with no linked Carrot event', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const res = await createPlan(ADMIN, {
      manualEvent: { name: 'Weekend in Cape Town', date: new Date(Date.now() + 5 * 86400000).toISOString(), location: 'Cape Town' },
      name: 'Road trip crew',
      visibility: 'private',
    }).expect(201);

    expect(res.body.data.eventId).toBeNull();
    expect(res.body.data.event).toBeNull();
    expect(res.body.data.manualEvent).toMatchObject({ name: 'Weekend in Cape Town', location: 'Cape Town' });

    // Never creates a real Event document.
    expect(await Event.countDocuments()).toBe(0);
  });

  it('rejects a create with both eventId and manualEvent', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const event = await makeEvent();
    await createPlan(ADMIN, {
      eventId: String(event._id),
      manualEvent: { name: 'Also this' },
      name: 'Conflicting',
      visibility: 'public',
    }).expect(400);
  });

  it('rejects a create with neither eventId nor manualEvent', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await createPlan(ADMIN, { name: 'No destination', visibility: 'public' }).expect(400);
  });

  it('lists a manual-event plan under My Plans > Upcoming and includes it in the Home feed when public', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const created = await createPlan(ADMIN, {
      manualEvent: { name: 'Beach day', date: new Date(Date.now() + 2 * 86400000).toISOString() },
      name: 'Beach day plan',
      visibility: 'public',
    }).expect(201);

    const mine = await request(app).get('/api/social/plans/mine?section=upcoming').set(auth(ADMIN)).expect(200);
    expect(mine.body.data.plans.map((p: any) => p.id)).toContain(created.body.data.id);
  });
});

describe('Trip Plan — Posts (photo/video)', () => {
  beforeAll(async () => {
    await connectTestDb();
    await EventPlan.init();
    await EventPlanMember.init();
    await EventPlanMessage.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function makeActivePlan() {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await createPlan(ADMIN, { eventId: String(event._id), name: 'Pregame', visibility: 'public' }).expect(201);
    return created.body.data.id as string;
  }

  it('creates an image post end-to-end and it appears in the Posts list as ready', async () => {
    const planId = await makeActivePlan();
    const prepared = await request(app)
      .post(`/api/social/plans/${planId}/posts`)
      .set(auth(ADMIN))
      .send({ kind: 'image', body: 'trip pic', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(201);
    expect(prepared.body.data.uploads).toHaveLength(1);
    const messageId = prepared.body.data.message.id;

    const finalized = await request(app)
      .post(`/api/social/plans/${planId}/posts/${messageId}/finalize`)
      .set(auth(ADMIN))
      .expect(200);
    expect(finalized.body.data.message.media[0].status).toBe('ready');

    const list = await request(app).get(`/api/social/plans/${planId}/messages`).expect(200);
    const post = list.body.data.messages.find((m: any) => m.id === messageId);
    expect(post.kind).toBe('image');
    expect(post.body).toBe('trip pic');
  });

  it('rejects more than one file for a video post', async () => {
    const planId = await makeActivePlan();
    await request(app)
      .post(`/api/social/plans/${planId}/posts`)
      .set(auth(ADMIN))
      .send({ kind: 'video', items: [{ ext: 'mp4', contentType: 'video/mp4' }, { ext: 'mp4', contentType: 'video/mp4' }] })
      .expect(400);
  });

  it('rejects posting from a non-member', async () => {
    const planId = await makeActivePlan();
    await makeBuyer('+26878000099', 'Outsider', 'outsider_one');
    await request(app)
      .post(`/api/social/plans/${planId}/posts`)
      .set(auth('+26878000099'))
      .send({ kind: 'image', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(403);
  });

  it('dedupes a retried create via clientToken instead of creating a second post', async () => {
    const planId = await makeActivePlan();
    const body = { kind: 'image', body: 'once', items: [{ ext: 'jpg', contentType: 'image/jpeg' }], clientToken: 'retry-key-1' };
    const first = await request(app).post(`/api/social/plans/${planId}/posts`).set(auth(ADMIN)).send(body).expect(201);
    const second = await request(app).post(`/api/social/plans/${planId}/posts`).set(auth(ADMIN)).send(body).expect(201);

    expect(second.body.data.message.id).toBe(first.body.data.message.id);
    expect(second.body.data.uploads).toHaveLength(0);
    expect(await EventPlanMessage.countDocuments({ planId })).toBe(1);
  });

  it('lets the author edit a caption and delete their own post', async () => {
    const planId = await makeActivePlan();
    const sent = await request(app).post(`/api/social/plans/${planId}/messages`).set(auth(ADMIN)).send({ body: 'hello' }).expect(201);
    const messageId = sent.body.data.message.id;

    const edited = await request(app)
      .patch(`/api/social/plans/${planId}/messages/${messageId}`)
      .set(auth(ADMIN))
      .send({ body: 'hello edited' })
      .expect(200);
    expect(edited.body.data.message.body).toBe('hello edited');
    expect(edited.body.data.message.editedAt).toBeTruthy();

    await request(app).delete(`/api/social/plans/${planId}/messages/${messageId}`).set(auth(ADMIN)).expect(200);
    expect(await EventPlanMessage.findById(messageId).then((m) => m?.deletedAt)).toBeTruthy();
  });

  it("lets the plan admin delete another member's post (moderation), but not an unrelated member", async () => {
    const planId = await makeActivePlan();
    // FRIEND joins the public/open plan first.
    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(FRIEND)).expect(200);
    const sent = await request(app).post(`/api/social/plans/${planId}/messages`).set(auth(FRIEND)).send({ body: 'friend post' }).expect(201);
    const messageId = sent.body.data.message.id;

    await request(app).delete(`/api/social/plans/${planId}/messages/${messageId}`).set(auth(ADMIN)).expect(200);
    expect(await EventPlanMessage.findById(messageId).then((m) => m?.deletedAt)).toBeTruthy();
  });

  it('marks posts read and clears the unread count for that viewer only', async () => {
    const planId = await makeActivePlan();
    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(FRIEND)).expect(200);
    await request(app).post(`/api/social/plans/${planId}/messages`).set(auth(FRIEND)).send({ body: 'unread to admin' }).expect(201);

    const before = await request(app).get(`/api/social/plans/${planId}`).set(auth(ADMIN)).expect(200);
    expect(before.body.data.plan.viewer.unreadCount).toBeGreaterThan(0);

    await request(app).post(`/api/social/plans/${planId}/read`).set(auth(ADMIN)).expect(200);

    const after = await request(app).get(`/api/social/plans/${planId}`).set(auth(ADMIN)).expect(200);
    expect(after.body.data.plan.viewer.unreadCount).toBe(0);
  });
});

describe('Trip Plan — cover photo', () => {
  beforeAll(async () => {
    await connectTestDb();
    await EventPlan.init();
    await EventPlanMember.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function makePlan() {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await createPlan(ADMIN, { eventId: String(event._id), name: 'Scorpion Kings trip', visibility: 'public' }).expect(201);
    return created.body.data.id as string;
  }

  it('has no cover photo until one is uploaded', async () => {
    const planId = await makePlan();
    const res = await request(app).get(`/api/social/plans/${planId}`).expect(200);
    expect(res.body.data.plan.coverImage).toBeNull();
  });

  it('uploads and finalizes a cover photo, surfacing it on the detail, mine and Home-feed responses', async () => {
    const planId = await makePlan();
    const presigned = await request(app)
      .post(`/api/social/plans/${planId}/cover/presign`)
      .set(auth(ADMIN))
      .send({ ext: 'jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(presigned.body.data.uploadUrl).toContain('https://r2.example/put');

    const finalized = await request(app)
      .post(`/api/social/plans/${planId}/cover/finalize`)
      .set(auth(ADMIN))
      .send({ rawKey: presigned.body.data.rawKey })
      .expect(200);
    expect(finalized.body.data.plan.coverImage).toBe(`https://cdn.carrottickets.com/${presigned.body.data.rawKey}`);

    const detail = await request(app).get(`/api/social/plans/${planId}`).expect(200);
    expect(detail.body.data.plan.coverImage).toBe(finalized.body.data.plan.coverImage);

    const mine = await request(app).get('/api/social/plans/mine?section=upcoming').set(auth(ADMIN)).expect(200);
    expect(mine.body.data.plans.find((p: any) => p.id === planId).coverImage).toBe(finalized.body.data.plan.coverImage);
  });

  it('rejects a non-admin from setting the cover photo', async () => {
    const planId = await makePlan();
    await request(app)
      .post(`/api/social/plans/${planId}/cover/presign`)
      .set(auth(FRIEND))
      .send({ ext: 'jpg', contentType: 'image/jpeg' })
      .expect(403);
  });

  it('rejects an unsupported file type', async () => {
    const planId = await makePlan();
    await request(app)
      .post(`/api/social/plans/${planId}/cover/presign`)
      .set(auth(ADMIN))
      .send({ ext: 'gif', contentType: 'image/gif' })
      .expect(400);
  });

  it('removes the cover photo', async () => {
    const planId = await makePlan();
    const presigned = await request(app)
      .post(`/api/social/plans/${planId}/cover/presign`)
      .set(auth(ADMIN))
      .send({ ext: 'png', contentType: 'image/png' })
      .expect(200);
    await request(app)
      .post(`/api/social/plans/${planId}/cover/finalize`)
      .set(auth(ADMIN))
      .send({ rawKey: presigned.body.data.rawKey })
      .expect(200);

    await request(app).delete(`/api/social/plans/${planId}/cover`).set(auth(ADMIN)).expect(200);
    const detail = await request(app).get(`/api/social/plans/${planId}`).expect(200);
    expect(detail.body.data.plan.coverImage).toBeNull();
  });
});
