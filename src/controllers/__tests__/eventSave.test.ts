import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { EventReaction } from '@models/eventReaction.model';
import publicRoutes from '@routes/public.route';

const app = express();
app.use(express.json());
app.use('/api/public', publicRoutes);

async function seedEvent() {
  return Event.create({
    name: 'Bushfire',
    venue: 'House on Fire',
    eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000),
    endTime: new Date(Date.now() + 90000000),
    vendorId: new mongoose.Types.ObjectId(),
  });
}

const BUYER_PHONE = '+26878422613';
const buyerAuth = () => ({ Authorization: `Bearer ${signBuyerToken(BUYER_PHONE)}` });

describe('POST /api/public/events/:eventId/save', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  // avatarUrl matters only for the cross-check tests below that POST /like:
  // that route is mounted behind requireProfilePhoto, so a photoless buyer
  // 403s and creates no reaction at all. /save itself is not gated.
  beforeEach(async () => {
    await Buyer.create({ phone: BUYER_PHONE, password: 'secret123', username: 'tester', avatarUrl: 'https://cdn.test/avatar.jpg' });
  });

  it('401s an anonymous save — never a silent no-op', async () => {
    const e = await seedEvent();
    const res = await request(app).post(`/api/public/events/${e.id}/save`);
    expect(res.status).toBe(401);
  });

  it('404s an unknown event', async () => {
    const unknown = new mongoose.Types.ObjectId().toString();
    const res = await request(app).post(`/api/public/events/${unknown}/save`).set(buyerAuth());
    expect(res.status).toBe(404);
  });

  it('creates a type:save reaction (not type:like) when toggled on for an authenticated buyer', async () => {
    const e = await seedEvent();

    const on = await request(app).post(`/api/public/events/${e.id}/save`).set(buyerAuth());
    expect(on.status).toBe(200);
    expect(on.body.data.active).toBe(true);

    const rows = await EventReaction.find({ eventId: e.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('save');
  });

  it('toggles a save on then off, removing the type:save reaction', async () => {
    const e = await seedEvent();

    await request(app).post(`/api/public/events/${e.id}/save`).set(buyerAuth());
    const off = await request(app).post(`/api/public/events/${e.id}/save`).set(buyerAuth());
    expect(off.body.data.active).toBe(false);

    const rows = await EventReaction.find({ eventId: e.id, type: 'save' });
    expect(rows).toHaveLength(0);
  });

  it('lets a vendor session save an event', async () => {
    const e = await seedEvent();
    const vendorId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post(`/api/public/events/${e.id}/save`)
      .set({ Authorization: `Bearer ${signVendorToken(vendorId)}` });
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
  });

  it('liking an event does NOT create a save reaction — save and like are independent', async () => {
    const e = await seedEvent();

    await request(app).post(`/api/public/events/${e.id}/like`).set(buyerAuth());

    const saveRows = await EventReaction.find({ eventId: e.id, type: 'save' });
    expect(saveRows).toHaveLength(0);
    const likeRows = await EventReaction.find({ eventId: e.id, type: 'like' });
    expect(likeRows).toHaveLength(1);
  });

  it('saving an event does NOT create a like reaction or bump likeCount', async () => {
    const e = await seedEvent();

    await request(app).post(`/api/public/events/${e.id}/save`).set(buyerAuth());

    const likeRows = await EventReaction.find({ eventId: e.id, type: 'like' });
    expect(likeRows).toHaveLength(0);
    const updated = await Event.findById(e.id).select('likeCount').lean();
    expect(updated?.likeCount ?? 0).toBe(0);
  });
});
