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

const PHONE = '+26878422613';

async function makeEvent(overrides: Record<string, any> = {}) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Event',
    venue: 'V',
    eventDate: new Date('2026-08-10'),
    startTime: new Date('2026-08-10'),
    endTime: new Date('2026-08-10'),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
    status: EventStatus.PUBLISHED,
    ...overrides,
  });
}

/**
 * The PUBLIC calendar: what's on, for everyone. Distinct from
 * /api/social/me/calendar (going + saved, auth required) — here a viewer only
 * changes how rows are MARKED, never which rows come back.
 */
describe('GET /api/public/calendar', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns every published event in the year to an anonymous visitor', async () => {
    await makeEvent({ name: 'Aug Show' });
    await makeEvent({ name: 'Mar Show', eventDate: new Date('2026-03-02') });

    const res = await request(app).get('/api/public/calendar?year=2026').expect(200);
    expect(res.body.data.monthCounts).toEqual({ Mar: 1, Aug: 1 });
    expect(res.body.data.events.map((e: any) => e.name)).toEqual(['Mar Show', 'Aug Show']);
  });

  // The whole point of the change: listing an event puts it on everyone's
  // calendar, with no organizer behind it and nothing for an admin to approve.
  it('includes a buyer self-listed event (no vendor, no ticket types)', async () => {
    const lister = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Lister' });
    await makeEvent({
      name: 'Community Listing',
      vendorId: undefined,
      submittedByBuyerId: lister._id,
      ticketTypes: [],
    });

    const res = await request(app).get('/api/public/calendar?year=2026').expect(200);
    const listed = res.body.data.events.find((e: any) => e.name === 'Community Listing');
    expect(listed).toBeTruthy();
    expect(listed.organizer).toBeNull();
  });

  it('excludes unpublished events and other years', async () => {
    await makeEvent({ name: 'Draft', status: EventStatus.DRAFT });
    await makeEvent({ name: 'Pending', status: EventStatus.PENDING_APPROVAL });
    await makeEvent({ name: 'Next Year', eventDate: new Date('2027-01-04') });
    await makeEvent({ name: 'Live' });

    const res = await request(app).get('/api/public/calendar?year=2026').expect(200);
    expect(res.body.data.events.map((e: any) => e.name)).toEqual(['Live']);
  });

  it('keeps a past event on the calendar (unlike the forward-only events list)', async () => {
    await makeEvent({
      name: 'Already Happened',
      eventDate: new Date('2026-01-05'),
      startTime: new Date('2026-01-05'),
      endTime: new Date('2026-01-05'),
    });

    const res = await request(app).get('/api/public/calendar?year=2026').expect(200);
    expect(res.body.data.events.map((e: any) => e.name)).toEqual(['Already Happened']);
  });

  it('marks the signed-in viewer’s going and saved rows without filtering', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const saved = await makeEvent({ name: 'Saved', eventDate: new Date('2026-04-01') });
    await EventReaction.create({ eventId: saved._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });
    const going = await makeEvent({ name: 'Going', eventDate: new Date('2026-05-01') });
    await Ticket.create({ eventId: going._id, vendorId: going.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.SOLD });
    await makeEvent({ name: 'Neither', eventDate: new Date('2026-06-01') });

    const res = await request(app)
      .get('/api/public/calendar?year=2026')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const byName = Object.fromEntries(res.body.data.events.map((e: any) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['Going', 'Neither', 'Saved']);
    expect(byName['Saved'].viewerHasSaved).toBe(true);
    expect(byName['Saved'].viewerIsGoing).toBe(false);
    expect(byName['Going'].viewerIsGoing).toBe(true);
    expect(byName['Neither'].viewerIsGoing).toBe(false);
    expect(byName['Neither'].viewerHasSaved).toBe(false);
  });

  it('defaults to the current UTC year and rejects a nonsense one', async () => {
    const now = new Date();
    await makeEvent({ name: 'This Year', eventDate: new Date(Date.UTC(now.getUTCFullYear(), 5, 1)) });
    await makeEvent({ name: 'Old', eventDate: new Date(Date.UTC(now.getUTCFullYear() - 1, 5, 1)) });

    const res = await request(app).get('/api/public/calendar').expect(200);
    expect(res.body.data.events.map((e: any) => e.name)).toEqual(['This Year']);

    await request(app).get('/api/public/calendar?year=nope').expect(400);
  });
});
