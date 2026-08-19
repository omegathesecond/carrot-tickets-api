// api/src/routes/__tests__/cashlessRequest.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';
const OTHER_VENDOR = '64c000000000000000000b02';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string } = {}) {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:view_events', 'tickets:edit_event'],
    isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId ?? VENDOR,
  }, JWT_SECRET);
}

async function makeEvent(vendorId = VENDOR) {
  const future = new Date(Date.now() + 7 * 864e5);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name: 'Show', venue: 'V',
    eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('PUT /api/tickets/events/:id — cashless is admin-only over HTTP', () => {
  it('403s an organizer switching cashless on', async () => {
    const event = await makeEvent();

    const res = await request(app)
      .put(`/api/tickets/events/${event._id}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ cashless: true });

    expect(res.status).toBe(403);
    expect(await Event.findById(event._id).then((e) => e!.cashless)).toBe(false);
  });

  it('lets an admin switch it on', async () => {
    const event = await makeEvent();

    const res = await request(app)
      .put(`/api/tickets/events/${event._id}`)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ cashless: true });

    expect(res.status).toBe(200);
    expect(await Event.findById(event._id).then((e) => e!.cashless)).toBe(true);
  });
});

describe('POST /api/tickets/events/:id/cashless-request', () => {
  it('stamps the request and reports success', async () => {
    const event = await makeEvent();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/cashless-request`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ note: 'Two bars and a food court' });

    expect(res.status).toBe(200);
    const after = await Event.findById(event._id);
    expect(after!.cashlessRequestedAt).toBeTruthy();
    expect(after!.cashlessRequestNote).toBe('Two bars and a food court');
  });

  it('accepts an empty body — the note is optional', async () => {
    const event = await makeEvent();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/cashless-request`)
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
  });

  it('404s another organizer\'s event rather than revealing it exists', async () => {
    const event = await makeEvent(OTHER_VENDOR);

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/cashless-request`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ note: 'Mine now' });

    expect(res.status).toBe(404);
  });

  it('rejects a note longer than the field allows', async () => {
    const event = await makeEvent();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/cashless-request`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ note: 'x'.repeat(301) });

    expect(res.status).toBe(400);
  });
});
