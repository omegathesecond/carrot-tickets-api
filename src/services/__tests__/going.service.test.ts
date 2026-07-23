import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { GoingService } from '@services/going.service';

const PHONE = '+26878422613';

async function makeEvent(name: string) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name,
    venue: 'V',
    eventDate: new Date(),
    startTime: new Date(),
    endTime: new Date(),
    ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }],
  });
}

describe('GoingService.goingEventIds', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('includes events whose community the buyer joined', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const e = await makeEvent('Joined');
    const community = await Community.create({ eventId: e._id, vendorId: e.vendorId });
    await Membership.create({ buyerId: buyer._id, communityId: community._id, role: 'member' });

    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).toContain(String(e._id));
  });

  it('excludes events for a membership the buyer was banned from', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const e = await makeEvent('Banned');
    const community = await Community.create({ eventId: e._id, vendorId: e.vendorId });
    await Membership.create({ buyerId: buyer._id, communityId: community._id, role: 'member', bannedAt: new Date() });

    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).not.toContain(String(e._id));
  });

  it('includes events where the buyer holds a SOLD ticket', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const e = await makeEvent('Sold Ticket');
    await Ticket.create({ eventId: e._id, vendorId: e.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.SOLD });

    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).toContain(String(e._id));
  });

  it('includes events where the buyer holds a CHECKED_IN ticket', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const e = await makeEvent('Checked In');
    await Ticket.create({ eventId: e._id, vendorId: e.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.CHECKED_IN });

    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).toContain(String(e._id));
  });

  it('excludes events where the ticket is refunded, cancelled, or still available', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const refunded = await makeEvent('Refunded');
    const cancelled = await makeEvent('Cancelled');
    const available = await makeEvent('Available');
    await Ticket.create({ eventId: refunded._id, vendorId: refunded.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.REFUNDED });
    await Ticket.create({ eventId: cancelled._id, vendorId: cancelled.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.CANCELLED });
    await Ticket.create({ eventId: available._id, vendorId: available.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.AVAILABLE });

    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).not.toContain(String(refunded._id));
    expect(ids).not.toContain(String(cancelled._id));
    expect(ids).not.toContain(String(available._id));
  });

  it('de-dupes when the buyer both joined the community and holds a ticket for the same event', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const e = await makeEvent('Both');
    const community = await Community.create({ eventId: e._id, vendorId: e.vendorId });
    await Membership.create({ buyerId: buyer._id, communityId: community._id, role: 'member' });
    await Ticket.create({ eventId: e._id, vendorId: e.vendorId, ticketType: 'GA', price: 0, customerPhone: PHONE, status: TicketStatus.SOLD });

    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids.filter((id: string) => id === String(e._id))).toHaveLength(1);
  });

  it('returns [] when the buyer has neither a joined community nor a ticket', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const ids = await GoingService.goingEventIds(buyer as any);
    expect(ids).toEqual([]);
  });
});
