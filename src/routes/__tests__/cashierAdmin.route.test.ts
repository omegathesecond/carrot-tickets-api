// api/src/routes/__tests__/cashierAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

/**
 * A cashier is hired for exactly ONE event, so this admin surface is
 * deliberately NOT the multi-event `eventIds` contract the gate operators
 * still use (see operatorEventAssignment.route.test.ts) — create takes a
 * singular required `eventId`, update cannot move her, and list scopes to
 * the event the dashboard panel is rendered inside.
 */

// validateEventAssignment's own refusal — a non-existent event and another
// organizer's event are deliberately indistinguishable to the caller, so
// neither doubles as a probe for whether an event id exists.
const FOREIGN_EVENT_MESSAGE = 'One or more events do not exist or belong to a different organizer';
// A buyer self-listed community event has no owning vendor, so there is no
// organizer to hire for.
const NO_ORGANIZER_MESSAGE = 'That event has no organizer to hire a cashier for';

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
// index. Crockford base32 (no I/L/O/U), e.g. '4KZ9P2'.
let __loginCodeSeq = 600;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Two of MY events (the second exists so the list filter has something to
// filter OUT) plus one belonging to a different organizer.
let myEventId: string;
let mySecondEventId: string;
let otherVendorEventId: string;

beforeEach(async () => {
  myEventId = await eventFor(VENDOR_A, 'My Show');
  mySecondEventId = await eventFor(VENDOR_A, 'My Other Show');
  otherVendorEventId = await eventFor(VENDOR_B, 'Someone Elses Show');
});

describe('POST /api/tickets/cashiers', () => {
  it('hires a cashier onto one of my events', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId });

    expect(res.status).toBe(201);
    expect(res.body.data.cashier.eventId).toBe(myEventId);
    expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    // The pin is returned once at the top level and never serialized on the row.
    expect(res.body.data.cashier.pin).toBeUndefined();
  });

  it('requires an eventId for an organizer cashier', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa' });

    expect(res.status).toBe(400);
    // Pinned to the CONTROLLER's own message, not just /eventId/i — the
    // schema `required` also rejects this, and a loose matcher would go on
    // passing if the controller guard were deleted, hiding the fact that the
    // refusal had silently moved to a mongoose ValidationError.
    expect(res.body.message).toBe('eventId is required');
    expect(await Cashier.countDocuments({})).toBe(0);
  });

  it("rejects an event belonging to another organizer", async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: otherVendorEventId });

    expect(res.status).toBe(400);
    // Pinned to the VALIDATOR's own message. A bare /event/i would also match
    // the schema's ValidationError, so it would keep passing if the whole
    // `if (scope === 'organizer')` block were deleted — hiding the fact that
    // the cross-organizer check had stopped running.
    expect(res.body.message).toBe(FOREIGN_EVENT_MESSAGE);
    expect(await Cashier.countDocuments({})).toBe(0);
  });

  it('rejects an event id that does not exist', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(FOREIGN_EVENT_MESSAGE);
    expect(await Cashier.countDocuments({})).toBe(0);
  });

  it("checks a super-admin's eventId against the ORGANIZER being hired for, not the caller", async () => {
    const ok = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Nomsa', scope: 'organizer', vendorId: VENDOR_B, eventId: otherVendorEventId });
    expect(ok.status).toBe(201);

    const mismatched = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Sipho', scope: 'organizer', vendorId: VENDOR_A, eventId: otherVendorEventId });
    expect(mismatched.status).toBe(400);
  });

  // The in-event Cashiers panel sends { fullName, eventId } and has no
  // vendorId to send — the event is its only context. Mirrors
  // MerchantAdminController, which already derives the vendor from the event.
  it('derives the organizer from the event when a super-admin sends no vendorId', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId });

    expect(res.status).toBe(201);
    // Re-read raw rather than trusting the response body — this asserts what
    // was actually persisted, which is what scopeFilter will later match on.
    const stored = await Cashier.findById(res.body.data.cashier._id);
    expect(stored!.scope).toBe('organizer');
    expect(stored!.vendorId!.toString()).toBe(VENDOR_A);
    expect(stored!.eventId!.toString()).toBe(myEventId);
  });

  it('does NOT become permissive when a super-admin passes a vendorId that does not own the event', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Nomsa', scope: 'organizer', vendorId: VENDOR_B, eventId: myEventId });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(FOREIGN_EVENT_MESSAGE);
    expect(await Cashier.countDocuments({})).toBe(0);
  });

  it('refuses an event with no organizer rather than creating a vendorless cashier', async () => {
    // A buyer self-listed community event: published, but nobody sells or
    // gets paid for it, so it has no vendorId at all.
    const future = new Date(Date.now() + 7 * 864e5);
    const community = await Event.create({
      name: 'Community Braai', venue: 'V', submittedByBuyerId: new mongoose.Types.ObjectId(),
      eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
      ticketTypes: [{ name: 'General', price: 0, quantity: 10, sold: 0, reserved: 0 }],
    });

    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Nomsa', eventId: (community._id as any).toString() });

    expect(res.status).toBe(400);
    // Pinned to the exact message: the OLD "vendorId is required for
    // organizer scope" also matches /organizer/i, so a loose matcher would
    // keep passing if the derivation were removed entirely.
    expect(res.body.message).toBe(NO_ORGANIZER_MESSAGE);
    // An organizer-scope row with no vendorId is invisible to every
    // scopeFilter and therefore unmanageable — none may exist.
    expect(await Cashier.countDocuments({})).toBe(0);
  });

  it('refuses an event that does not exist when deriving', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Nomsa', eventId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(400);
    // Status alone would also be satisfied by the pre-derivation
    // "vendorId is required for organizer scope" refusal.
    expect(res.body.message).toBe('Event not found');
    expect(await Cashier.countDocuments({})).toBe(0);
  });

  it('an ordinary organizer still takes the vendor from their TOKEN, not the event', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId, vendorId: VENDOR_B });

    expect(res.status).toBe(201);
    // VENDOR_B in the body is ignored outright — an organizer can only ever
    // hire for themselves, and the event still has to be theirs.
    const stored = await Cashier.findById(res.body.data.cashier._id);
    expect(stored!.vendorId!.toString()).toBe(VENDOR_A);
  });

  it('lets a platform cashier be created with no event at all', async () => {
    const res = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Carrot Staff', scope: 'platform' });

    expect(res.status).toBe(201);
    expect(res.body.data.cashier.eventId).toBeUndefined();
  });
});

describe('PATCH /api/tickets/cashiers/:id', () => {
  it('ignores eventIds on update', async () => {
    const created = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId });
    const id = created.body.data.cashier._id;

    const res = await request(app).patch(`/api/tickets/cashiers/${id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ eventIds: [otherVendorEventId] });
    expect(res.status).toBe(200);

    // Reloaded from the DB, not read off the response — an in-memory doc can
    // look right while the write silently no-ops or silently lands.
    const reloaded = await Cashier.findById(id);
    expect(reloaded!.eventId!.toString()).toBe(myEventId);
  });

  it('ignores a singular eventId on update too (the field is immutable)', async () => {
    const created = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId });
    const id = created.body.data.cashier._id;

    const res = await request(app).patch(`/api/tickets/cashiers/${id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ eventId: mySecondEventId });
    expect(res.status).toBe(200);

    const reloaded = await Cashier.findById(id);
    expect(reloaded!.eventId!.toString()).toBe(myEventId);
  });

  it('400s a fullName that is not a non-empty string, rather than renaming her to it', async () => {
    const created = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId });
    const id = created.body.data.cashier._id;

    for (const fullName of [123, null, '', '   ']) {
      const res = await request(app).patch(`/api/tickets/cashiers/${id}`)
        .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
        .send({ fullName });

      // 400 — not the 200 that used to rename her to the string "123", and
      // not the 500 that `null` used to produce by throwing a Mongoose
      // ValidationError into next(err).
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('fullName must be a non-empty string');
    }

    const reloaded = await Cashier.findById(id);
    expect(reloaded!.fullName).toBe('Nomsa');
  });

  it('still updates the fields that ARE mutable', async () => {
    const created = await request(app).post('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa', eventId: myEventId });
    const id = created.body.data.cashier._id;

    const res = await request(app).patch(`/api/tickets/cashiers/${id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Nomsa Dlamini', isActive: false });

    expect(res.status).toBe(200);
    const reloaded = await Cashier.findById(id);
    expect(reloaded!.fullName).toBe('Nomsa Dlamini');
    expect(reloaded!.isActive).toBe(false);
    expect(reloaded!.eventId!.toString()).toBe(myEventId);
  });
});

describe('GET /api/tickets/cashiers', () => {
  beforeEach(async () => {
    await Cashier.create([
      { fullName: 'Nomsa', loginCode: nextLoginCode(), pin: '111111', scope: 'organizer', vendorId: VENDOR_A, eventId: myEventId },
      { fullName: 'Sipho', loginCode: nextLoginCode(), pin: '222222', scope: 'organizer', vendorId: VENDOR_A, eventId: mySecondEventId },
    ]);
  });

  it('filters the list to one event', async () => {
    const res = await request(app).get(`/api/tickets/cashiers?eventId=${myEventId}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].fullName).toBe('Nomsa');
  });

  it('returns every cashier when no event is named (the platform page)', async () => {
    const res = await request(app).get('/api/tickets/cashiers')
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { fullName: string }) => c.fullName).sort()).toEqual(['Nomsa', 'Sipho']);
  });

  it("never leaks another organizer's cashier through the event filter", async () => {
    const theirs = await Cashier.create({
      fullName: 'Theirs', loginCode: nextLoginCode(), pin: '333333',
      scope: 'organizer', vendorId: VENDOR_B, eventId: otherVendorEventId,
    });

    const res = await request(app).get(`/api/tickets/cashiers?eventId=${otherVendorEventId}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(await Cashier.findById(theirs._id)).not.toBeNull();
  });
});
