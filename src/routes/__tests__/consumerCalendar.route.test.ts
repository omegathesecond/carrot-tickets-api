import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import { Follow } from '@models/follow.model';

const PHONE = '+26878422613';

async function makeEvent(overrides: Record<string, any> = {}) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Event',
    venue: 'V',
    eventDate: new Date(),
    startTime: new Date(),
    endTime: new Date(),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
    ...overrides,
  });
}

describe('GET /api/social/me/calendar', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it("groups the buyer's saved events into month counts for the year", async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const e = await makeEvent({ name: 'Aug Event', eventDate: new Date('2026-08-10'), startTime: new Date('2026-08-10'), endTime: new Date('2026-08-10') });
    await EventReaction.create({ eventId: e._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/me/calendar?year=2026').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.monthCounts.Aug).toBe(1);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Aug Event']);
  });

  it('unions going (ticketed) events with saved events, de-duped', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const saved = await makeEvent({ name: 'Saved Only', eventDate: new Date('2026-03-05') });
    await EventReaction.create({ eventId: saved._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const ticketed = await makeEvent({ name: 'Ticketed Only', eventDate: new Date('2026-03-15') });
    await Ticket.create({ eventId: ticketed._id, vendorId: ticketed.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.SOLD });

    const both = await makeEvent({ name: 'Both', eventDate: new Date('2026-03-20') });
    await EventReaction.create({ eventId: both._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    await Ticket.create({ eventId: both._id, vendorId: both.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.SOLD });

    const res = await request(app).get('/api/social/me/calendar?year=2026').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.monthCounts.Mar).toBe(3);
    const names = res.body.data.events.map((c: any) => c.name);
    expect(names.sort()).toEqual(['Both', 'Saved Only', 'Ticketed Only']);
  });

  it('excludes events outside the requested year', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const inYear = await makeEvent({ name: 'In 2026', eventDate: new Date('2026-01-15') });
    await EventReaction.create({ eventId: inYear._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    const outOfYear = await makeEvent({ name: 'In 2025', eventDate: new Date('2025-12-31') });
    await EventReaction.create({ eventId: outOfYear._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    const nextYear = await makeEvent({ name: 'In 2027', eventDate: new Date('2027-01-01') });
    await EventReaction.create({ eventId: nextYear._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/me/calendar?year=2026').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['In 2026']);
    expect(res.body.data.monthCounts).toEqual({ Jan: 1 });
  });

  it('defaults to the current UTC year when no year is given', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const now = new Date();
    const thisYear = await makeEvent({ name: 'This Year', eventDate: now });
    await EventReaction.create({ eventId: thisYear._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });
    const lastYear = await makeEvent({ name: 'Last Year', eventDate: new Date(Date.UTC(now.getUTCFullYear() - 1, 5, 1)) });
    await EventReaction.create({ eventId: lastYear._id, buyerId: buyer._id, actorType: 'buyer', type: 'like' });

    const res = await request(app).get('/api/social/me/calendar').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['This Year']);
  });

  it('returns empty month counts and events when nothing saved or going', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const res = await request(app).get('/api/social/me/calendar?year=2026').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.monthCounts).toEqual({});
    expect(res.body.data.events).toEqual([]);
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/me/calendar?year=2026').expect(401);
  });
});

describe('GET /api/social/me/following/events', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns upcoming published events from followed organizers, soonest first', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const vendorId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'organizer', targetId: vendorId });

    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await makeEvent({ name: 'Later Show', vendorId, eventDate: later, endTime: later, status: EventStatus.PUBLISHED });
    await makeEvent({ name: 'Soon Show', vendorId, eventDate: soon, endTime: soon, status: EventStatus.PUBLISHED });

    const res = await request(app).get('/api/social/me/following/events').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Soon Show', 'Later Show']);
  });

  it('excludes events from organizers the buyer does not follow', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const followedVendor = new mongoose.Types.ObjectId();
    const otherVendor = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'organizer', targetId: followedVendor });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await makeEvent({ name: 'Followed Org', vendorId: followedVendor, eventDate: future, endTime: future, status: EventStatus.PUBLISHED });
    await makeEvent({ name: 'Unfollowed Org', vendorId: otherVendor, eventDate: future, endTime: future, status: EventStatus.PUBLISHED });

    const res = await request(app).get('/api/social/me/following/events').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Followed Org']);
  });

  it('excludes non-published events and past events from a followed organizer', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const vendorId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'organizer', targetId: vendorId });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await makeEvent({ name: 'Draft Future', vendorId, eventDate: future, endTime: future, status: EventStatus.DRAFT });
    await makeEvent({ name: 'Published Past', vendorId, eventDate: past, endTime: past, status: EventStatus.PUBLISHED });
    await makeEvent({ name: 'Published Future', vendorId, eventDate: future, endTime: future, status: EventStatus.PUBLISHED });

    const res = await request(app).get('/api/social/me/following/events').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Published Future']);
  });

  it('returns an empty list when the buyer follows no organizers', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const res = await request(app).get('/api/social/me/following/events').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('still includes an in-progress event (started but not yet ended) from a followed organizer', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const vendorId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId: buyer._id, targetType: 'organizer', targetId: vendorId });

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await makeEvent({ name: 'In Progress Show', vendorId, eventDate: past, startTime: past, endTime: future, status: EventStatus.PUBLISHED });

    const res = await request(app).get('/api/social/me/following/events').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['In Progress Show']);
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/me/following/events').expect(401);
  });
});
