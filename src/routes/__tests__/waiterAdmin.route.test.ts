// api/src/routes/__tests__/waiterAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

/**
 * A waiter is hired for exactly ONE event, mirroring Cashier (see
 * cashierAdmin.route.test.ts) — create takes a singular required `eventId`,
 * update cannot move her, and list scopes to the event the dashboard panel is
 * rendered inside.
 */

const FOREIGN_EVENT_MESSAGE = 'One or more events do not exist or belong to a different organizer';
// A buyer self-listed community event has no owning vendor, so there is no
// organizer to hire for.
const NO_ORGANIZER_MESSAGE = 'That event has no organizer to hire a waiter for';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_A = '64c000000000000000000a01';
const VENDOR_B = '64c000000000000000000b02';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string }) {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId,
  }, JWT_SECRET);
}

async function eventFor(vendorId: string, name: string) {
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name, venue: 'V',
    eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return (event._id as any).toString() as string;
}

// Per-file incrementing sequence, not Math.random() — a random pick over a
// small range collides across it() blocks and flakes the unique loginCode
// index (see cashierAdmin.route.test.ts).
let __loginCodeSeq = 700;
const nextLoginCode = () => `5KZ${__loginCodeSeq++}`;

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let myEventId: string;
let mySecondEventId: string;
let otherVendorEventId: string;

beforeEach(async () => {
  myEventId = await eventFor(VENDOR_A, 'My Show');
  mySecondEventId = await eventFor(VENDOR_A, 'My Other Show');
  otherVendorEventId = await eventFor(VENDOR_B, 'Someone Elses Show');
});

async function hire(fullName: string, eventId: string) {
  const res = await request(app).post('/api/tickets/waiters')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ fullName, eventId });
  return res.body.data.waiter;
}

describe('POST /api/tickets/waiters', () => {
  it('hires a waiter onto one of my events, returning a login code and PIN once', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: myEventId });

    expect(res.status).toBe(201);
    expect(res.body.data.waiter.eventId).toBe(myEventId);
    expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    // The pin is returned once at the top level and never serialized on the row.
    expect(res.body.data.waiter.pin).toBeUndefined();
  });

  it('requires an eventId for an organizer waiter', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('eventId is required');
    expect(await Waiter.countDocuments({})).toBe(0);
  });

  it("rejects an event belonging to another organizer", async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: otherVendorEventId });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(FOREIGN_EVENT_MESSAGE);
    expect(await Waiter.countDocuments({})).toBe(0);
  });

  it('rejects an event id that does not exist', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(FOREIGN_EVENT_MESSAGE);
    expect(await Waiter.countDocuments({})).toBe(0);
  });

  it('derives the organizer from the event when an admin hires (super-admin token carries no organizer)', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Thabo', eventId: myEventId });

    expect(res.status).toBe(201);
    expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    expect(String(res.body.data.waiter.vendorId)).toBe(VENDOR_A);

    // Re-read raw rather than trusting the response body.
    const stored = await Waiter.findById(res.body.data.waiter._id);
    expect(stored!.scope).toBe('organizer');
    expect(stored!.vendorId!.toString()).toBe(VENDOR_A);
    expect(stored!.eventId!.toString()).toBe(myEventId);
  });

  it('does NOT become permissive when a super-admin passes a vendorId that does not own the event', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Thabo', scope: 'organizer', vendorId: VENDOR_B, eventId: myEventId });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(FOREIGN_EVENT_MESSAGE);
    expect(await Waiter.countDocuments({})).toBe(0);
  });

  it('refuses an event with no organizer rather than creating a vendorless waiter', async () => {
    const future = new Date(Date.now() + 7 * 864e5);
    const community = await Event.create({
      name: 'Community Braai', venue: 'V', submittedByBuyerId: new mongoose.Types.ObjectId(),
      eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
      ticketTypes: [{ name: 'General', price: 0, quantity: 10, sold: 0, reserved: 0 }],
    });

    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Thabo', eventId: (community._id as any).toString() });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(NO_ORGANIZER_MESSAGE);
    expect(await Waiter.countDocuments({})).toBe(0);
  });

  it('refuses an event that does not exist when deriving, with "Event not found"', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Thabo', eventId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Event not found');
    expect(await Waiter.countDocuments({})).toBe(0);
  });

  it('an ordinary organizer still takes the vendor from their TOKEN, not the event', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: myEventId, vendorId: VENDOR_B });

    expect(res.status).toBe(201);
    const stored = await Waiter.findById(res.body.data.waiter._id);
    expect(stored!.vendorId!.toString()).toBe(VENDOR_A);
  });

  it('lets a platform waiter be created with no event at all', async () => {
    const res = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Carrot Staff', scope: 'platform' });

    expect(res.status).toBe(201);
    expect(res.body.data.waiter.eventId).toBeUndefined();
  });
});

describe('PATCH /api/tickets/waiters/:id', () => {
  it('ignores a singular eventId on update (the field is immutable)', async () => {
    const created = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: myEventId });
    const id = created.body.data.waiter._id;

    const res = await request(app).patch(`/api/tickets/waiters/${id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ eventId: mySecondEventId });
    expect(res.status).toBe(200);

    const reloaded = await Waiter.findById(id);
    expect(reloaded!.eventId!.toString()).toBe(myEventId);
  });

  it('400s a fullName that is not a non-empty string, rather than renaming her to it', async () => {
    const created = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: myEventId });
    const id = created.body.data.waiter._id;

    for (const fullName of [123, null, '', '   ']) {
      const res = await request(app).patch(`/api/tickets/waiters/${id}`)
        .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
        .send({ fullName });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('fullName must be a non-empty string');
    }

    const reloaded = await Waiter.findById(id);
    expect(reloaded!.fullName).toBe('Thabo');
  });

  it('400s a non-boolean isActive rather than coercing "false" to true', async () => {
    const created = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: myEventId });
    const id = created.body.data.waiter._id;

    for (const isActive of ['false', 'true', 0, 1, null]) {
      const res = await request(app).patch(`/api/tickets/waiters/${id}`)
        .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
        .send({ isActive });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('isActive must be a boolean');
    }

    const reloaded = await Waiter.findById(id);
    expect(reloaded!.isActive).toBe(true);
  });

  it('still updates the fields that ARE mutable, including disabling a waiter', async () => {
    const created = await request(app).post('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo', eventId: myEventId });
    const id = created.body.data.waiter._id;

    const res = await request(app).patch(`/api/tickets/waiters/${id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Thabo Nkosi', isActive: false });

    expect(res.status).toBe(200);
    const reloaded = await Waiter.findById(id);
    expect(reloaded!.fullName).toBe('Thabo Nkosi');
    expect(reloaded!.isActive).toBe(false);
    expect(reloaded!.eventId!.toString()).toBe(myEventId);
  });

  it('turns settling on for somebody already hired', async () => {
    const hired = await hire('Thabo', myEventId);
    expect(hired.grants ?? []).toEqual([]);

    const res = await request(app).patch(`/api/tickets/waiters/${hired._id}`)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ grants: ['settle_tables'] });

    expect(res.status).toBe(200);
    expect(res.body.data.grants).toEqual(['settle_tables']);
    expect((await Waiter.findById(hired._id))!.grants).toEqual(['settle_tables']);
  });

  it('drops a grant that is not a real capability rather than storing it', async () => {
    const hired = await hire('Thabo', myEventId);

    const res = await request(app).patch(`/api/tickets/waiters/${hired._id}`)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ grants: ['settle_tables', 'not_a_real_grant'] });

    expect(res.status).toBe(200);
    expect((await Waiter.findById(hired._id))!.grants).toEqual(['settle_tables']);
  });

  it('leaves grants alone when the body does not mention them', async () => {
    const hired = await hire('Thabo', myEventId);
    await request(app).patch(`/api/tickets/waiters/${hired._id}`)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ grants: ['settle_tables'] });

    await request(app).patch(`/api/tickets/waiters/${hired._id}`)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Thabo M' });

    const after = await Waiter.findById(hired._id);
    expect(after!.fullName).toBe('Thabo M');
    expect(after!.grants).toEqual(['settle_tables']);
  });
});

describe('GET /api/tickets/waiters', () => {
  beforeEach(async () => {
    await Waiter.create([
      { fullName: 'Thabo', loginCode: nextLoginCode(), pin: '111111', scope: 'organizer', vendorId: VENDOR_A, eventId: myEventId },
      { fullName: 'Sipho', loginCode: nextLoginCode(), pin: '222222', scope: 'organizer', vendorId: VENDOR_A, eventId: mySecondEventId },
    ]);
  });

  it('an organizer sees only their own waiters', async () => {
    const theirs = await Waiter.create({
      fullName: 'Theirs', loginCode: nextLoginCode(), pin: '333333',
      scope: 'organizer', vendorId: VENDOR_B, eventId: otherVendorEventId,
    });

    const res = await request(app).get('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { fullName: string }) => w.fullName).sort()).toEqual(['Sipho', 'Thabo']);
    expect(await Waiter.findById(theirs._id)).not.toBeNull();
  });

  it('filters the list to one event', async () => {
    const res = await request(app).get(`/api/tickets/waiters?eventId=${myEventId}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].fullName).toBe('Thabo');
  });

  it('a super-admin sees every waiter when no event is named', async () => {
    const res = await request(app).get('/api/tickets/waiters')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { fullName: string }) => w.fullName).sort()).toEqual(['Sipho', 'Thabo']);
  });
});

describe('POST /api/tickets/waiters/:id/reset-pin', () => {
  it('mints a fresh PIN and clears lockout bookkeeping', async () => {
    const hired = await hire('Thabo', myEventId);
    await Waiter.updateOne({ _id: hired._id }, { failedPinAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) });

    const res = await request(app).post(`/api/tickets/waiters/${hired._id}/reset-pin`)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.pin).toMatch(/^\d{6}$/);

    const reloaded = await Waiter.findById(hired._id);
    expect(reloaded!.failedPinAttempts).toBe(0);
    expect(reloaded!.lockedUntil).toBeNull();
  });

  it('404s for a waiter outside the caller\'s scope', async () => {
    const theirs = await Waiter.create({
      fullName: 'Theirs', loginCode: nextLoginCode(), pin: '333333',
      scope: 'organizer', vendorId: VENDOR_B, eventId: otherVendorEventId,
    });

    const res = await request(app).post(`/api/tickets/waiters/${theirs._id}/reset-pin`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({});

    expect(res.status).toBe(404);
  });
});
