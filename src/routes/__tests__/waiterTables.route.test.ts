import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS } from '@interfaces/waiter.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** One waiter, working one freshly-created cashless event, token in hand. */
async function seedFloor() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(new mongoose.Types.ObjectId()),
    role: 'waiter', permissions: WAITER_PERMISSIONS, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token };
}

describe('waiter tables — open and list', () => {
  it('opens a table by number', async () => {
    const { token } = await seedFloor();
    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(res.status).toBe(201);
    expect(res.body.data.label).toBe('7');
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.subtotal).toBe(0);
  });

  it('refuses a second open table under the same number', async () => {
    const { token } = await seedFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    const again = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already open/i);
  });

  it('requires a label', async () => {
    const { token } = await seedFloor();
    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('lists only this event tables', async () => {
    const mine = await seedFloor();
    const other = await seedFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${mine.token}`).send({ label: '7' });

    const res = await request(app).get('/api/waiter/tables')
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.body.data.tables).toEqual([]);
  });
});
