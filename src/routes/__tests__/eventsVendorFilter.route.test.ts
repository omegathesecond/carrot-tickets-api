// api/src/routes/__tests__/eventsVendorFilter.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_A = '64c000000000000000000a01';
const VENDOR_B = '64c000000000000000000b02';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string }) {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:view_events'], isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId,
  }, JWT_SECRET);
}

async function eventFor(vendorId: string, name: string) {
  const future = new Date(Date.now() + 7 * 864e5);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name, venue: 'V',
    eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
}

const names = (res: any) => res.body.data.data.map((e: any) => e.name).sort();

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('super-admin sees every organizer by default', async () => {
  await eventFor(VENDOR_A, 'A Show');
  await eventFor(VENDOR_B, 'B Show');

  const res = await request(app).get('/api/tickets/events')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

  expect(res.status).toBe(200);
  expect(names(res)).toEqual(['A Show', 'B Show']);
});

it('super-admin can narrow to one organizer with ?vendorId=', async () => {
  await eventFor(VENDOR_A, 'A Show');
  await eventFor(VENDOR_B, 'B Show');

  const res = await request(app).get(`/api/tickets/events?vendorId=${VENDOR_B}`)
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

  expect(res.status).toBe(200);
  expect(names(res)).toEqual(['B Show']);
});

it('an organizer cannot use ?vendorId= to read another organizer', async () => {
  await eventFor(VENDOR_A, 'A Show');
  await eventFor(VENDOR_B, 'B Show');

  const res = await request(app).get(`/api/tickets/events?vendorId=${VENDOR_B}`)
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);

  expect(res.status).toBe(200);
  expect(names(res)).toEqual(['A Show']);
});

it('rejects a malformed vendorId rather than ignoring it', async () => {
  const res = await request(app).get('/api/tickets/events?vendorId=nonsense')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

  expect(res.status).toBe(400);
});
