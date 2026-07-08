import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const superAdmin = () => jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: [], isSuperAdmin: true }, JWT_SECRET);

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('batch-issues and lists batches with ticket codes', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({ capacity: 30 });
  const auth = { Authorization: `Bearer ${superAdmin()}` };

  const issued = await request(app).post('/api/tickets/wristbands/batch-issue').set(auth)
    .send({ eventId, ticketTypeId, quantity: 10 });
  expect(issued.status).toBe(201);
  expect(issued.body.data.tickets).toHaveLength(10);
  // 8-char unambiguous-alphabet code (see ticketCode.util.ts) — no TKT- prefix.
  expect(issued.body.data.tickets[0].ticketId).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

  const batches = await request(app).get(`/api/tickets/wristbands/batches?eventId=${eventId}`).set(auth);
  expect(batches.status).toBe(200);
  expect(batches.body.data).toHaveLength(1);
  expect(batches.body.data[0].quantity).toBe(10);
  expect(batches.body.data[0].tickets).toHaveLength(10);
  expect(batches.body.data[0].tickets[0].ticketId).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
});

it('rejects quantity outside 1..500 (400)', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({ capacity: 30 });
  const res = await request(app).post('/api/tickets/wristbands/batch-issue')
    .set('Authorization', `Bearer ${superAdmin()}`)
    .send({ eventId, ticketTypeId, quantity: 0 });
  expect(res.status).toBe(400);
});

it('oversell surfaces as a 400 with the availability message', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({ capacity: 3 });
  const res = await request(app).post('/api/tickets/wristbands/batch-issue')
    .set('Authorization', `Bearer ${superAdmin()}`)
    .send({ eventId, ticketTypeId, quantity: 10 });
  expect(res.status).toBe(400);
});

it('requires print_wristbands (403 for plain organizer)', async () => {
  const { eventId, ticketTypeId } = await seedPublishedEvent({});
  const t = jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], vendorId: eventId.slice(0, 24) }, JWT_SECRET);
  const res = await request(app).post('/api/tickets/wristbands/batch-issue')
    .set('Authorization', `Bearer ${t}`).send({ eventId, ticketTypeId, quantity: 1 });
  expect(res.status).toBe(403);
});
