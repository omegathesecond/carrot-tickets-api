import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

describe('GET /api/public/events?category=', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const common = () => ({
    vendorId: new mongoose.Types.ObjectId(),
    venue: 'V',
    eventDate: new Date(Date.now() + 8.64e7),
    startTime: new Date(Date.now() + 8.64e7),
    endTime: new Date(Date.now() + 9e7),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }],
  });

  it('filters to the requested category and includes category in the card', async () => {
    await Event.create({ ...common(), name: 'Gig', category: 'Music' });
    await Event.create({ ...common(), name: 'Expo', category: 'Tech' });
    const res = await request(app).get('/api/public/events?category=Music').expect(200);
    const names = res.body.data.events?.map((e: any) => e.name) ?? res.body.data.map((e: any) => e.name);
    expect(names).toContain('Gig');
    expect(names).not.toContain('Expo');
  });

  it('includes category on the card, and legacy events without a category serialize as Other', async () => {
    await Event.create({ ...common(), name: 'Gig', category: 'Music' });
    // Legacy-shaped event: no category field set at all (mimics pre-migration docs).
    await Event.collection.insertOne({
      ...common(),
      name: 'Legacy',
      ticketTypes: [{ _id: new mongoose.Types.ObjectId(), name: 'GA', price: 10, quantity: 5, available: 5 }],
    } as any);

    const res = await request(app).get('/api/public/events').expect(200);
    const events = res.body.data.events ?? res.body.data;
    const gig = events.find((e: any) => e.name === 'Gig');
    const legacy = events.find((e: any) => e.name === 'Legacy');
    expect(gig.category).toBe('Music');
    expect(legacy.category).toBe('Other');
  });

  it('treats category=All the same as no filter', async () => {
    await Event.create({ ...common(), name: 'Gig', category: 'Music' });
    await Event.create({ ...common(), name: 'Expo', category: 'Tech' });
    const res = await request(app).get('/api/public/events?category=All').expect(200);
    const names = res.body.data.events?.map((e: any) => e.name) ?? res.body.data.map((e: any) => e.name);
    expect(names).toContain('Gig');
    expect(names).toContain('Expo');
  });
});
