import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';

const auth = (phone: string) => ({ Authorization: `Bearer ${signBuyerToken(phone)}` });
const ADMIN = '+26878422613';
const FRIEND = '+26878000001';
const OUTSIDER = '+26878000002';

const AVATAR = 'https://cdn.carrottickets.com/test/avatar.jpg';

async function makeEvent(overrides: Partial<any> = {}, futureDays = 30) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Test Event',
    venue: 'Test Venue',
    eventDate: new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000),
    startTime: new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000 + 3600_000),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
    ...overrides,
  });
}

async function makeBuyer(phone: string, name: string, username: string) {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: AVATAR, name, username });
}

async function makePlan(visibility: 'public' | 'private' = 'public') {
  await makeBuyer(ADMIN, 'Admin', 'admin_one');
  const event = await makeEvent();
  const created = await request(app)
    .post('/api/social/plans')
    .set(auth(ADMIN))
    .send({ eventId: String(event._id), name: 'Social plan', visibility, joinPolicy: 'open' })
    .expect(201);
  return { planId: created.body.data.id as string, event };
}

describe('event plan social engagement (like/save/share/comment)', () => {
  beforeAll(async () => {
    await connectTestDb();
    await EventPlan.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('likes and unlikes a public plan, keeping likeCount in sync everywhere the plan renders', async () => {
    const { planId, event } = await makePlan('public');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');

    const liked = await request(app).post(`/api/social/plans/${planId}/like`).set(auth(FRIEND)).expect(200);
    expect(liked.body.data).toEqual({ active: true, likeCount: 1, saveCount: 0 });

    // Event-detail "Plans With Friends" card.
    const onEvent = await request(app).get(`/api/social/plans/event/${event._id}`).set(auth(FRIEND)).expect(200);
    expect(onEvent.body.data.plans[0].likeCount).toBe(1);
    expect(onEvent.body.data.plans[0].viewerReactions).toEqual({ liked: true, saved: false });

    // Full plan detail.
    const detail = await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
    expect(detail.body.data.plan.likeCount).toBe(1);
    expect(detail.body.data.plan.viewerReactions.liked).toBe(true);

    // A different viewer never sees FRIEND's like as their own.
    await makeBuyer(OUTSIDER, 'Out', 'out_one');
    const asOutsider = await request(app).get(`/api/social/plans/${planId}`).set(auth(OUTSIDER)).expect(200);
    expect(asOutsider.body.data.plan.likeCount).toBe(1);
    expect(asOutsider.body.data.plan.viewerReactions.liked).toBe(false);

    // Toggling again unlikes.
    const unliked = await request(app).post(`/api/social/plans/${planId}/like`).set(auth(FRIEND)).expect(200);
    expect(unliked.body.data).toEqual({ active: false, likeCount: 0, saveCount: 0 });
  });

  it('saves a public plan independently of likes', async () => {
    const { planId } = await makePlan('public');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');

    const saved = await request(app).post(`/api/social/plans/${planId}/save`).set(auth(FRIEND)).expect(200);
    expect(saved.body.data).toEqual({ active: true, likeCount: 0, saveCount: 1 });

    const detail = await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
    expect(detail.body.data.plan.viewerReactions).toEqual({ liked: false, saved: true });
  });

  it('records a share even for an anonymous visitor', async () => {
    const { planId } = await makePlan('public');
    const shared = await request(app).post(`/api/social/plans/${planId}/share`).expect(200);
    expect(shared.body.data).toEqual({ shareCount: 1 });
    const again = await request(app).post(`/api/social/plans/${planId}/share`).expect(200);
    expect(again.body.data).toEqual({ shareCount: 2 });
  });

  it('rejects like/save/share/comment on a private plan even for the admin', async () => {
    const { planId } = await makePlan('private');
    await request(app).post(`/api/social/plans/${planId}/like`).set(auth(ADMIN)).expect(403);
    await request(app).post(`/api/social/plans/${planId}/save`).set(auth(ADMIN)).expect(403);
    await request(app).post(`/api/social/plans/${planId}/share`).expect(403);
    await request(app).post(`/api/social/plans/${planId}/comments`).set(auth(ADMIN)).send({ body: 'hey' }).expect(403);
    await request(app).get(`/api/social/plans/${planId}/comments`).set(auth(ADMIN)).expect(403);
  });

  it('rejects unauthenticated like/save/comment', async () => {
    const { planId } = await makePlan('public');
    await request(app).post(`/api/social/plans/${planId}/like`).expect(401);
    await request(app).post(`/api/social/plans/${planId}/save`).expect(401);
    await request(app).post(`/api/social/plans/${planId}/comments`).send({ body: 'hey' }).expect(401);
  });

  it('posts a top-level comment and a reply, likes a comment, and reflects commentCount on the plan', async () => {
    const { planId } = await makePlan('public');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    void friend;

    const top = await request(app)
      .post(`/api/social/plans/${planId}/comments`)
      .set(auth(FRIEND))
      .send({ body: 'Can’t wait for this one!' })
      .expect(201);
    expect(top.body.data.body).toBe('Can’t wait for this one!');
    expect(top.body.data.parentId).toBeNull();

    const reply = await request(app)
      .post(`/api/social/plans/${planId}/comments`)
      .set(auth(ADMIN))
      .send({ body: 'Same here!', parentId: top.body.data.id })
      .expect(201);
    expect(reply.body.data.parentId).toBe(top.body.data.id);

    // Replying to a reply is rejected (one level of nesting only).
    await request(app)
      .post(`/api/social/plans/${planId}/comments`)
      .set(auth(FRIEND))
      .send({ body: 'nested', parentId: reply.body.data.id })
      .expect(400);

    const list = await request(app).get(`/api/social/plans/${planId}/comments`).expect(200);
    expect(list.body.data.comments).toHaveLength(1);
    expect(list.body.data.comments[0].replyCount).toBe(1);
    expect(list.body.data.comments[0].replies).toHaveLength(1);
    expect(list.body.data.comments[0].author.username).toBe('friend_one');

    const likeComment = await request(app).post(`/api/social/plans/plan-comments/${top.body.data.id}/like`).set(auth(ADMIN)).expect(200);
    expect(likeComment.body.data).toEqual({ active: true, likeCount: 1 });

    const plan = await EventPlan.findById(planId);
    expect(plan!.commentCount).toBe(2);
  });

  it('lets a commenter delete their own comment but not someone else\'s, decrementing commentCount', async () => {
    const { planId } = await makePlan('public');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');

    const top = await request(app).post(`/api/social/plans/${planId}/comments`).set(auth(FRIEND)).send({ body: 'delete me' }).expect(201);

    await request(app).delete(`/api/social/plans/plan-comments/${top.body.data.id}`).set(auth(ADMIN)).expect(403);
    await request(app).delete(`/api/social/plans/plan-comments/${top.body.data.id}`).set(auth(FRIEND)).expect(200);

    const list = await request(app).get(`/api/social/plans/${planId}/comments`).expect(200);
    expect(list.body.data.comments).toHaveLength(0);

    const plan = await EventPlan.findById(planId);
    expect(plan!.commentCount).toBe(0);
  });

  it('drops a plan changed from public to private out of the event listing while keeping its engagement counters', async () => {
    const { planId, event } = await makePlan('public');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    await request(app).post(`/api/social/plans/${planId}/like`).set(auth(FRIEND)).expect(200);

    await request(app)
      .patch(`/api/social/plans/${planId}/visibility`)
      .set(auth(ADMIN))
      .send({ visibility: 'private', confirmed: true })
      .expect(200);

    const listOutsider = await request(app).get(`/api/social/plans/event/${event._id}`).set(auth(FRIEND)).expect(200);
    expect(listOutsider.body.data.plans).toHaveLength(0);

    // Liking is now rejected, but the earlier like count is preserved.
    await request(app).post(`/api/social/plans/${planId}/like`).set(auth(FRIEND)).expect(403);
    const plan = await EventPlan.findById(planId);
    expect(plan!.likeCount).toBe(1);
  });
});
