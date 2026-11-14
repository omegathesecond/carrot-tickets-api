import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Buyer } from '@models/buyer.model';
import { signBuyerSessionToken } from '../../__tests__/helpers/auth';

describe('public events expose ticketing + externalTicketUrl', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets a signed-in buyer with zero follows, media or profile photo reach ticket buying', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Ticket buyer', username: 'ticket_buyer' });
    const authorization = `Bearer ${await signBuyerSessionToken('+26878422613')}`;
    const seeded = await seedPublishedEvent();
    const progress = await request(app).get('/api/social/me/onboarding').set('Authorization', authorization).expect(200);
    expect(progress.body.data).toMatchObject({ followingCount: 0, mediaCount: 0, canBrowse: false, canViewProfiles: false, hasProfilePhoto: false });
    const list = await request(app).get('/api/public/events').set('Authorization', authorization).expect(200);
    expect(list.body.data.events.some((event: { _id: string }) => event._id === seeded.eventId)).toBe(true);
    const detail = await request(app).get(`/api/public/events/${seeded.eventId}`).set('Authorization', authorization).expect(200);
    expect(detail.body.data.ticketTypes.length).toBeGreaterThan(0);
    // Deliberately incomplete: prove purchase validation is reachable without
    // creating an order or calling any payment provider.
    const purchase = await request(app).post('/api/public/purchase').set('Authorization', authorization).send({}).expect(400);
    expect(JSON.stringify(purchase.body)).not.toMatch(/FOLLOWING_REQUIRED|MEDIA_REQUIRED|PHOTO_REQUIRED/);
  });

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
