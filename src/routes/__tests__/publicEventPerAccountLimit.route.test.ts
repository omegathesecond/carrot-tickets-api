import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function makeEvent(extra: Record<string, unknown>) {
  const future = new Date(Date.now() + DAY);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Legends',
    venue: 'V',
    eventDate: future,
    startTime: future,
    endTime: new Date(future.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, sold: 0, reserved: 0 }],
    ...extra,
  });
}

describe('public event detail exposes maxTicketsPerAccount', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('includes the cap when the event has one', async () => {
    const event = await makeEvent({ maxTicketsPerAccount: 1 });
    const res = await request(app).get(`/api/public/events/${event._id}`).expect(200);
    expect(res.body.data.maxTicketsPerAccount).toBe(1);
  });

  it('leaves it null/absent when the event has no cap', async () => {
    const event = await makeEvent({});
    const res = await request(app).get(`/api/public/events/${event._id}`).expect(200);
    expect(res.body.data.maxTicketsPerAccount ?? null).toBeNull();
  });
});
