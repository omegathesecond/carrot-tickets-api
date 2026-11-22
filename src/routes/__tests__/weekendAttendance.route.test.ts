import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Buyer } from '@models/buyer.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { currentWeekendWindow } from '@utils/weekendWindow.util';

describe('weekend attendance', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
  it('unions live ticket holders and Going accounts once, excluding other statuses and weekends', async () => {
    const { start } = currentWeekendWindow();
    const vendorId = new mongoose.Types.ObjectId();
    const common = { vendorId, venue: 'Venue', eventDate: start, startTime: start, endTime: new Date(start.getTime() + 3600000), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10 }] };
    const event = await Event.create({ ...common, name: 'Weekend' });
    const outside = await Event.create({ ...common, name: 'Next week', eventDate: new Date(start.getTime() + 7 * 86400000), startTime: new Date(start.getTime() + 7 * 86400000), endTime: new Date(start.getTime() + 7 * 86400000 + 3600000) });
    const a = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'A', avatarUrl: 'https://example.com/a.jpg' });
    const b = await Buyer.create({ email: 'b@example.com', password: 'secret1', name: 'B' });
    const c = await Buyer.create({ email: 'c@example.com', password: 'secret1', name: 'C' });
    const community = await Community.create({ eventId: event._id, vendorId });
    await Membership.create({ communityId: community._id, buyerId: a._id });
    await Membership.create({ communityId: community._id, buyerId: c._id, bannedAt: new Date() });
    const ticket = { eventId: event._id, vendorId, ticketType: 'GA', price: 0 };
    await Ticket.create({ ...ticket, customerPhone: a.phone, status: TicketStatus.SOLD });
    await Ticket.create({ ...ticket, buyerId: a._id, status: TicketStatus.CHECKED_IN });
    await Ticket.create({ ...ticket, customerEmail: b.email, status: TicketStatus.SOLD });
    await Ticket.create({ ...ticket, buyerId: c._id, status: TicketStatus.REFUNDED });
    await Ticket.create({ ...ticket, eventId: outside._id, buyerId: a._id, status: TicketStatus.SOLD });
    const res = await request(app).get('/api/social/weekend/attendance').expect(200);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0]).toMatchObject({ name: 'Weekend', count: 2 });
    expect(res.body.data.events[0].attendees).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'A', avatarUrl: a.avatarUrl }), expect.objectContaining({ name: 'B' })]));
  });
  it('counts guest purchasers once and merges them with registered Going accounts', async () => {
    const { start } = currentWeekendWindow();
    const vendorId = new mongoose.Types.ObjectId();
    const common = { vendorId, venue: 'Venue', eventDate: start, startTime: start, endTime: new Date(start.getTime() + 3600000), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10 }] };
    const guestEvent = await Event.create({ ...common, name: 'Guests' });
    const mixedEvent = await Event.create({ ...common, name: 'Mixed' });
    const buyer = await Buyer.create({ phone: '+26878422613', email: 'buyer@example.com', password: 'secret1', name: 'Registered' });
    const community = await Community.create({ eventId: mixedEvent._id, vendorId });
    await Membership.create({ communityId: community._id, buyerId: buyer._id });
    const ticket = { vendorId, ticketType: 'GA', price: 0, status: TicketStatus.SOLD };
    await Ticket.create({ ...ticket, eventId: guestEvent._id, customerEmail: 'guest@example.com' });
    await Ticket.create({ ...ticket, eventId: guestEvent._id, customerEmail: 'guest@example.com' });
    await Ticket.create({ ...ticket, eventId: mixedEvent._id, customerPhone: buyer.phone });
    await Ticket.create({ ...ticket, eventId: mixedEvent._id, customerEmail: buyer.email });
    await Ticket.create({ ...ticket, eventId: mixedEvent._id, customerEmail: 'guest@example.com' });
    const res = await request(app).get('/api/social/weekend/attendance').expect(200);
    expect(res.body.data.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Guests', count: 1, attendees: [] }),
      expect.objectContaining({ name: 'Mixed', count: 2, attendees: [expect.objectContaining({ name: 'Registered' })] }),
    ]));
    expect(JSON.stringify(res.body)).not.toContain('guest@example.com');
  });

});
