// api/src/routes/__tests__/gateEventReads.route.test.ts
//
// A gate operator's token carries VIEW_EVENTS so the POS can list events and
// pick the one being worked. Two reads under that permission returned far
// more than a picker needs: /events/:id/creator handed back the organizer's
// email, phone, primary contact and per-event revenue, and /events/:id
// returned the event's raw revenue and sales summary. A door scanner must not
// be able to read the organizer's contact book or their takings.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 800;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

async function seed() {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: `org-${__loginCodeSeq}` });
  const vendorId = vendor._id as mongoose.Types.ObjectId;
  const { eventId } = await seedPublishedEvent({ vendorId });
  await Event.updateOne({ _id: eventId }, { $set: { totalRevenue: 12345, totalTicketsSold: 7 } });

  const loginCode = nextLoginCode();
  await GateOperator.create({ fullName: 'Gate', loginCode, pin: '123456', scope: 'organizer', vendorId });
  const { accessToken: gateToken } = await GateOperatorAuthService.login(loginCode, '123456');

  const organizerToken = jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner', vendorId: String(vendorId),
    permissions: [TicketsPermission.VIEW_EVENTS], isSuperAdmin: false,
  }, JWT_SECRET);

  return { eventId, vendorId: String(vendorId), gateToken, organizerToken };
}

describe('GET /api/tickets/events/:eventId', () => {
  it('serves a gate token the event WITHOUT its money fields, keeping the picker working', async () => {
    const { eventId, gateToken } = await seed();

    const res = await request(app).get(`/api/tickets/events/${eventId}`)
      .set('Authorization', `Bearer ${gateToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Snapshot Test Event');
    expect(res.body.data.ticketTypes).toHaveLength(1);
    expect(res.body.data).not.toHaveProperty('totalRevenue');
    expect(res.body.data).not.toHaveProperty('totalTicketsSold');
    expect(res.body.data).not.toHaveProperty('salesSummary');
  });

  it('serves the organizer the full payload, unchanged', async () => {
    const { eventId, organizerToken } = await seed();

    const res = await request(app).get(`/api/tickets/events/${eventId}`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalRevenue).toBe(12345);
    expect(res.body.data.totalTicketsSold).toBe(7);
    expect(res.body.data.salesSummary).toBeDefined();
  });
});

describe('GET /api/tickets/events/:eventId/creator', () => {
  it('403s a gate token — the organizer\'s contact details and revenue are not for the door', async () => {
    const { eventId, gateToken } = await seed();

    const res = await request(app).get(`/api/tickets/events/${eventId}/creator`)
      .set('Authorization', `Bearer ${gateToken}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/email|phoneNumber|totalRevenue/);
  });

  it('still serves the organizer their own creator card', async () => {
    const { eventId, organizerToken } = await seed();

    const res = await request(app).get(`/api/tickets/events/${eventId}/creator`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.creator.businessName).toBe('Org');
    expect(res.body.data.stats.totalRevenue).toBe(12345);
  });
});
