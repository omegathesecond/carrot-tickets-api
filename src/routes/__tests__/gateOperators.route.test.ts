// api/src/routes/__tests__/gateOperators.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_A = '64b000000000000000000a01';
const VENDOR_B = '64b000000000000000000b02';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string }) {
  return jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId }, JWT_SECRET);
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('super-admin creates a platform-wide gate operator and gets credentials once', async () => {
  const res = await request(app).post('/api/tickets/gate-operators')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ fullName: 'Platform Gate', scope: 'platform' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.scope).toBe('platform');
});

it('organizer create is forced to their own vendor + organizer scope', async () => {
  const res = await request(app).post('/api/tickets/gate-operators')
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
    .send({ fullName: 'Org Gate', scope: 'platform', vendorId: VENDOR_B }); // attempts to escalate
  expect(res.status).toBe(201);
  expect(res.body.data.operator.scope).toBe('organizer');
  expect(res.body.data.operator.vendorId).toBe(VENDOR_A);
});

it('organizer lists only their own operators', async () => {
  await GateOperator.create({ fullName: 'A', loginCode: '810001', pin: '111111', scope: 'organizer', vendorId: VENDOR_A });
  await GateOperator.create({ fullName: 'B', loginCode: '810002', pin: '111111', scope: 'organizer', vendorId: VENDOR_B });
  const res = await request(app).get('/api/tickets/gate-operators')
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
  expect(res.body.data[0].vendorId).toBe(VENDOR_A);
});

it('organizer cannot reset-pin another vendor operator (404)', async () => {
  const other = await GateOperator.create({ fullName: 'B', loginCode: '810003', pin: '111111', scope: 'organizer', vendorId: VENDOR_B });
  const res = await request(app).post(`/api/tickets/gate-operators/${other._id}/reset-pin`)
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`).send({});
  expect(res.status).toBe(404);
});

it('a caller without manage_access is forbidden (403)', async () => {
  const t = jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], vendorId: VENDOR_A }, JWT_SECRET);
  const res = await request(app).get('/api/tickets/gate-operators').set('Authorization', `Bearer ${t}`);
  expect(res.status).toBe(403);
});

// `!!req.body.isActive` read the STRING "false" as true: a client that sent
// the value as text re-activated the person it was trying to switch off.
it('PATCH 400s a non-boolean isActive rather than coercing "false" to true', async () => {
  const op = await GateOperator.create({ fullName: 'A', loginCode: '810004', pin: '111111', scope: 'organizer', vendorId: VENDOR_A });

  const res = await request(app).patch(`/api/tickets/gate-operators/${op._id}`)
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
    .send({ isActive: 'false' });

  expect(res.status).toBe(400);
  expect(res.body.message).toBe('isActive must be a boolean');
  const reloaded = await GateOperator.findById(op._id);
  expect(reloaded!.isActive).toBe(true);
});

describe('a super-admin creating a register account from inside an event', () => {
  // The in-event Register panel sends { fullName, eventIds:[id], grants } and
  // has no vendorId to send — the event is the only context it has. The
  // cashier admin surface already derives the organizer from the event
  // (see cashierAdmin.controller.ts); this one used to refuse instead.
  async function seedEvent(vendorId: string | null) {
    const { Event } = await import('@models/event.model');
    const future = new Date(Date.now() + 7 * 864e5);
    const mongoose = (await import('mongoose')).default;
    const ev = await Event.create({
      // A buyer self-listed community event is the vendor-less case: published,
      // but nobody sells or gets paid for it, so the model exempts it from
      // requiring a vendorId (see event.model.ts).
      ...(vendorId ? { vendorId } : { submittedByBuyerId: new mongoose.Types.ObjectId() }),
      name: 'Umhlanga', venue: 'V', eventDate: future, startTime: future, endTime: future,
      ticketTypes: [],
    });
    return String(ev._id);
  }

  it('derives the organizer from the event it is created against', async () => {
    const eventId = await seedEvent(VENDOR_A);

    const res = await request(app).post('/api/tickets/gate-operators')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Teddy', eventIds: [eventId], grants: ['issue_tags'] });

    expect(res.status).toBe(201);
    expect(res.body.data.operator.scope).toBe('organizer');
    expect(res.body.data.operator.vendorId).toBe(VENDOR_A);
    expect(res.body.data.operator.eventIds).toEqual([eventId]);
  });

  it('still refuses when there is no event to derive from', async () => {
    const res = await request(app).post('/api/tickets/gate-operators')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Teddy', eventIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('vendorId is required for organizer scope');
  });

  it('refuses an event that does not exist when deriving', async () => {
    const res = await request(app).post('/api/tickets/gate-operators')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Teddy', eventIds: ['64b000000000000000000f99'] });

    expect(res.status).toBe(400);
    // Status alone would also be satisfied by the pre-derivation
    // "vendorId is required for organizer scope" refusal.
    expect(res.body.message).toBe('Event not found');
    expect(await GateOperator.countDocuments({})).toBe(0);
  });

  it('refuses an event with no organizer behind it', async () => {
    // A buyer self-listed community event has no owning vendor. An
    // organizer-scope row with no vendorId is invisible to every scopeFilter
    // and therefore unmanageable — none may exist.
    const eventId = await seedEvent(null);

    const res = await request(app).post('/api/tickets/gate-operators')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Teddy', eventIds: [eventId] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no organizer/i);
    expect(await GateOperator.countDocuments({})).toBe(0);
  });

  it('an explicit vendorId still wins, and is still held to that vendor', async () => {
    const eventId = await seedEvent(VENDOR_A);

    const res = await request(app).post('/api/tickets/gate-operators')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Teddy', eventIds: [eventId], vendorId: VENDOR_B });

    // VENDOR_B does not own the event, so the assignment validator refuses it
    // rather than quietly pointing B's staff at A's show.
    expect(res.status).toBe(400);
    expect(await GateOperator.countDocuments({})).toBe(0);
  });
});
