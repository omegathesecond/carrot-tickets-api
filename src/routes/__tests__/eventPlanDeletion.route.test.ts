import { seedBuyerFollows } from '../../__tests__/helpers/onboarding';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerSessionToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';
import { EventPlanMember } from '@models/eventPlanMember.model';
import { EventPlanMessage } from '@models/eventPlanMessage.model';
import { EventPlanMessageReaction } from '@models/eventPlanMessageReaction.model';
import { EventPlanComment } from '@models/eventPlanComment.model';
import { EventPlanCommentReaction } from '@models/eventPlanCommentReaction.model';
import { EventPlanReaction } from '@models/eventPlanReaction.model';

const auth = async (phone: string) => ({ Authorization: `Bearer ${await signBuyerSessionToken(phone)}` });
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
  const buyer = await Buyer.create({ phone, password: 'secret1', avatarUrl: AVATAR, name, username });
  await seedBuyerFollows('buyer', buyer.id);
  return buyer;
}

describe('hangout deletion', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('rolls back deletion if removing related records fails', async () => {
    const admin = await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const plan = await EventPlan.create({ adminId: admin._id, manualEvent: { name: 'Trip' }, name: 'Crew' });
    const failure = jest.spyOn(EventPlanMember, 'deleteMany').mockRejectedValueOnce(new Error('Database unavailable'));
    try {
      await request(app).delete(`/api/social/plans/${plan.id}`).set(await auth(ADMIN)).expect(500);
      expect(await EventPlan.findById(plan.id)).not.toBeNull();
    } finally {
      failure.mockRestore();
    }
  });

  it.each(['active', 'cancelled'])('only the creator can delete a %s hangout, without deleting its event', async (status) => {
    const admin = await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const plan = await EventPlan.create({ adminId: admin._id, eventId: event._id, name: 'Our hangout', status });
    await EventPlanMember.create({ planId: plan._id, buyerId: friend._id, role: 'member', status: 'accepted' });
    const message = await EventPlanMessage.create({ planId: plan._id, senderId: admin._id, body: 'Meet here' });
    const comment = await EventPlanComment.create({ planId: plan._id, authorType: 'buyer', authorId: friend._id, body: 'Great' });
    await EventPlanCommentReaction.create({ commentId: comment._id, buyerId: admin._id, type: 'like' });
    await EventPlanMessageReaction.create({ planId: plan._id, messageId: message._id, buyerId: friend._id, emoji: '👍' });
    await EventPlanReaction.create({ planId: plan._id, buyerId: friend._id, type: 'save' });
    const path = `/api/social/plans/${plan.id}`;
    await request(app).delete(path).expect(401);
    await request(app).delete(path).set(await auth(FRIEND)).expect(403);
    expect(await EventPlan.findById(plan.id)).not.toBeNull();
    await request(app).delete(path).set(await auth(ADMIN)).expect(200);
    expect(await EventPlan.findById(plan.id)).toBeNull();
    expect(await EventPlanMember.countDocuments({ planId: plan._id })).toBe(0);
    for (const model of [EventPlanMessage, EventPlanMessageReaction, EventPlanComment, EventPlanReaction] as any[]) {
      expect(await model.countDocuments({ planId: plan._id })).toBe(0);
    }
    expect(await EventPlanCommentReaction.countDocuments({ commentId: comment._id })).toBe(0);
    expect(await Event.findById(event._id)).not.toBeNull();
    await request(app).get(path).set(await auth(FRIEND)).expect(404);
    await request(app).get(`${path}/messages`).set(await auth(FRIEND)).expect(404);
    await request(app).delete(path).set(await auth(ADMIN)).expect(404);
    const list = await request(app).get(`/api/social/plans/event/${event.id}`).expect(200);
    expect(list.body.data.plans).toEqual([]);
  });
});
