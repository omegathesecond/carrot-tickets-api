// api/src/routes/__tests__/tagReport.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';
const OTHER = '64c000000000000000000b02';

const token = (perms: string[], vendorId = VENDOR) =>
  jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: perms, isSuperAdmin: false, vendorId }, JWT_SECRET);

async function cashlessEvent(vendorId = VENDOR) {
  const future = new Date(Date.now() + 7 * 864e5);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name: 'Fest', venue: 'V',
    eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('403s without view_revenue', async () => {
  const event = await cashlessEvent();
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags`)
    .set('Authorization', `Bearer ${token(['tickets:view_events'])}`);
  expect(res.status).toBe(403);
});

it("403s another vendor's event", async () => {
  const event = await cashlessEvent(OTHER);
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(403);
});

it('400s a non-cashless event', async () => {
  const event = await cashlessEvent();
  await Event.updateOne({ _id: event._id }, { cashless: false });
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(400);
});

it('serves the summary route rather than treating "summary" as a tag id', async () => {
  const event = await cashlessEvent();
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags/summary`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveProperty('balanceOutstanding');
});

it('400s a malformed cursor', async () => {
  const event = await cashlessEvent();
  const res = await request(app)
    .get(`/api/tickets/events/${event._id}/tags?cursor=nope`)
    .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`);
  expect(res.status).toBe(400);
});
