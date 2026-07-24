import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

describe('public events expose ticketing + externalTicketUrl', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('detail includes ticketing:"external" + externalTicketUrl for an externally-sold event', async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const event = await Event.create({
      vendorId: new mongoose.Types.ObjectId(),
      name: 'Ext',
      venue: 'V',
      eventDate: futureDate,
      startTime: futureDate,
      endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
      status: EventStatus.PUBLISHED,
      ticketing: 'external',
      externalTicketUrl: 'https://x.tickets/e',
      ticketTypes: [{ name: 'GA', price: 100, quantity: 10, sold: 0, reserved: 0 }],
    });

    const res = await request(app).get(`/api/public/events/${event._id}`).expect(200);
    expect(res.body.data.ticketing).toBe('external');
    expect(res.body.data.externalTicketUrl).toBe('https://x.tickets/e');
  });

  it('detail serializes a carrot/legacy event as ticketing:"carrot" with externalTicketUrl null', async () => {
    const seeded = await seedPublishedEvent(); // default ticketing (schema default 'carrot'), no externalTicketUrl

    const res = await request(app).get(`/api/public/events/${seeded.eventId}`).expect(200);
    expect(res.body.data.ticketing).toBe('carrot');
    expect(res.body.data.externalTicketUrl).toBeNull();
  });

  it('list also includes ticketing + externalTicketUrl on each card', async () => {
    const seeded = await seedPublishedEvent({ ticketing: 'external' as any });
    // seedPublishedEvent doesn't set externalTicketUrl; patch it directly so the
    // list-mapper path is exercised end-to-end too.
    await Event.updateOne({ _id: seeded.eventId }, { $set: { externalTicketUrl: 'https://x.tickets/list' } });

    const res = await request(app).get('/api/public/events').expect(200);
    const event = res.body.data.events.find((e: any) => e._id === seeded.eventId);
    expect(event).toBeDefined();
    expect(event.ticketing).toBe('external');
    expect(event.externalTicketUrl).toBe('https://x.tickets/list');
  });
});
