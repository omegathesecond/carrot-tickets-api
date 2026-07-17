import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
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

describe('POST /api/public/events/:eventId/like', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  // resolveActorFromRequest -> resolveBuyerFromRequest looks up a Buyer row by
  // the token's normalized phone; without this row the actor resolves to null
  // and every buyer-authed request here 401s before it can reach the
  // event-existence check or the toggle itself.
  beforeEach(async () => {
    await Buyer.create({ phone: BUYER_PHONE, password: 'secret123', username: 'tester' });
  });

  it('401s an anonymous like — never a silent no-op', async () => {
    const e = await seedEvent();
    const res = await request(app).post(`/api/public/events/${e.id}/like`);
    expect(res.status).toBe(401);
  });

  it('404s an unknown event', async () => {
    const unknown = new mongoose.Types.ObjectId().toString();
    const res = await request(app).post(`/api/public/events/${unknown}/like`).set(buyerAuth());
    expect(res.status).toBe(404);
  });

  it('toggles a like on then off for an authenticated buyer', async () => {
    const e = await seedEvent();

    const on = await request(app).post(`/api/public/events/${e.id}/like`).set(buyerAuth());
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ active: true, likeCount: 1 });

    const off = await request(app).post(`/api/public/events/${e.id}/like`).set(buyerAuth());
    expect(off.body.data).toEqual({ active: false, likeCount: 0 });
  });

  it('lets a vendor session like an event', async () => {
    const e = await seedEvent();
    const vendorId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post(`/api/public/events/${e.id}/like`)
      .set({ Authorization: `Bearer ${signVendorToken(vendorId)}` });
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
  });
});

describe('POST /api/public/events/:eventId/share', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('allows an anonymous share — sharing needs no actor', async () => {
    const e = await seedEvent();
    const res = await request(app).post(`/api/public/events/${e.id}/share`);
    expect(res.status).toBe(200);
    expect(res.body.data.shareCount).toBe(1);
  });
});
