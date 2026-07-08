import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const superAdmin = () => jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], isSuperAdmin: true }, JWT_SECRET);

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedTicket(eventId: string, vendorId: string, over: Partial<any> = {}) {
  return Ticket.create({
    eventId, vendorId, ticketType: 'General', price: 100,
    customerName: 'Thabo M', customerPhone: '+26878422613',
    status: TicketStatus.SOLD, ...over,
  });
}

it('lists sold + checked-in tickets for the event, searchable', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await seedTicket(eventId, vendorId);
  await seedTicket(eventId, vendorId, { customerName: 'Zanele K', status: TicketStatus.CHECKED_IN });
  await seedTicket(eventId, vendorId, { status: TicketStatus.REFUNDED }); // excluded
  const other = await seedPublishedEvent({ vendorId: new mongoose.Types.ObjectId() });
  await seedTicket(other.eventId, other.vendorId); // other event, excluded

  const auth = { Authorization: `Bearer ${superAdmin()}` };
  const all = await request(app).get(`/api/tickets/wristbands/tickets?eventId=${eventId}`).set(auth);
  expect(all.status).toBe(200);
  expect(all.body.data).toHaveLength(2);
  expect(all.body.data[0]).toHaveProperty('ticketId');
  expect(all.body.data[0]).toHaveProperty('status');

  const searched = await request(app).get(`/api/tickets/wristbands/tickets?eventId=${eventId}&search=zanele`).set(auth);
  expect(searched.body.data).toHaveLength(1);
  expect(searched.body.data[0].customerName).toBe('Zanele K');
});

it('403s without print_wristbands', async () => {
  const { eventId } = await seedPublishedEvent({});
  const t = jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], vendorId: new mongoose.Types.ObjectId().toHexString() }, JWT_SECRET);
  const res = await request(app).get(`/api/tickets/wristbands/tickets?eventId=${eventId}`).set('Authorization', `Bearer ${t}`);
  expect(res.status).toBe(403);
});
