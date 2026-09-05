import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS, WaiterPermission } from '@interfaces/waiter.interface';
import { Waiter } from '@models/waiter.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let waiterSeq = 0;

/**
 * The Waiter ROW is real, not just the token: the event scope is re-resolved
 * from that row on every request, so a token naming no row is refused.
 */
async function seed() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const waiter = await Waiter.create({
    fullName: 'Thabo', loginCode: `WTRE${waiterSeq++}`, pin: '123456',
    scope: 'organizer', vendorId, eventId: event._id,
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id),
    role: 'waiter', permissions: WAITER_PERMISSIONS, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token, waiterId: String(waiter._id) };
}

describe('the waiter floor screen', () => {
  it('lists the event this waiter works', async () => {
    const { eventId, token } = await seed();
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: any) => e.id)).toEqual([eventId]);
  });

  it('401s without a waiter token', async () => {
    await seed();
    const res = await request(app).get('/api/waiter/events');
    expect(res.status).toBe(401);
  });

  it('401s a cashier token — the scope claim is not interchangeable', async () => {
    await seed();
    const cashierToken = jwt.sign({ scope: 'cashier', userType: 'cashier' }, JWT_SECRET);
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(res.status).toBe(401);
  });

  it('403s a waiter token missing VIEW_EVENTS — authenticated, but not authorised', async () => {
    // A valid, correctly-scoped waiter token — it passes authenticateWaiter
    // fine — just without the one capability this route requires. A 401
    // here would mean the request never reached requireWaiterPermission at
    // all, which would prove nothing about the gate.
    const { eventId, waiterId } = await seed();
    const token = jwt.sign({
      scope: 'waiter', userType: 'waiter', waiterId,
      role: 'waiter', permissions: [], isSuperAdmin: false,
      fullName: 'Thabo', eventId,
    }, JWT_SECRET);
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(`Permission required: ${WaiterPermission.VIEW_EVENTS}`);
  });
});
