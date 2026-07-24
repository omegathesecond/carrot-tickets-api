import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Buyer } from '@models/buyer.model';

describe('GET /api/public/events/live', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  const common = () => ({
    vendorId: new mongoose.Types.ObjectId(),
    venue: 'V',
    ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }],
  });

  it('returns in-progress events with a live attendee count', async () => {
    const now = Date.now();
    const live = await Event.create({ ...common(), name: 'Live', eventDate: new Date(now - 3.6e6), startTime: new Date(now - 3.6e6), endTime: new Date(now + 3.6e6), status: EventStatus.PUBLISHED });
    await Event.create({ ...common(), name: 'Future', eventDate: new Date(now + 8.64e7), startTime: new Date(now + 8.64e7), endTime: new Date(now + 9e7), status: EventStatus.PUBLISHED });
    const community = await Community.create({ eventId: live._id, vendorId: live.vendorId });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    await Membership.create({ buyerId: buyer._id, communityId: community._id, role: 'member' });

    const res = await request(app).get('/api/public/events/live').expect(200);
    const names = res.body.data.events.map((e: any) => e.name);
    expect(names).toEqual(['Live']);
    expect(res.body.data.events[0].liveAttendees).toBe(1);
  });

  it('excludes events that already ended and events that have not started yet', async () => {
    const now = Date.now();
    await Event.create({ ...common(), name: 'Ended', eventDate: new Date(now - 9e7), startTime: new Date(now - 9e7), endTime: new Date(now - 3.6e6), status: EventStatus.PUBLISHED });
    await Event.create({ ...common(), name: 'NotStarted', eventDate: new Date(now + 3.6e6), startTime: new Date(now + 3.6e6), endTime: new Date(now + 9e7), status: EventStatus.PUBLISHED });

    const res = await request(app).get('/api/public/events/live').expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('excludes a live-windowed event that is not PUBLISHED', async () => {
    const now = Date.now();
    await Event.create({ ...common(), name: 'Draft', eventDate: new Date(now - 3.6e6), startTime: new Date(now - 3.6e6), endTime: new Date(now + 3.6e6), status: EventStatus.DRAFT });

    const res = await request(app).get('/api/public/events/live').expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('reports liveAttendees: 0 for a live event with no community/members yet', async () => {
    const now = Date.now();
    await Event.create({ ...common(), name: 'Live', eventDate: new Date(now - 3.6e6), startTime: new Date(now - 3.6e6), endTime: new Date(now + 3.6e6), status: EventStatus.PUBLISHED });

    const res = await request(app).get('/api/public/events/live').expect(200);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0].liveAttendees).toBe(0);
  });

  it('resolves before the /events/:eventId param route (does not treat "live" as an eventId)', async () => {
    const res = await request(app).get('/api/public/events/live').expect(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.success ?? true).not.toBe(false);
  });
});
