import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import { CommunityMembershipService } from '@services/communityMembership.service';

describe('external event community join', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedExternalEvent() {
    return Event.create({
      name: 'Ext',
      venue: 'V',
      eventDate: new Date(Date.now() + 8.64e7),
      startTime: new Date(),
      endTime: new Date(),
      status: EventStatus.PUBLISHED,
      ticketing: 'external',
      externalTicketUrl: 'https://x.tickets/e',
      ticketTypes: [],
      vendorId: new mongoose.Types.ObjectId(),
    });
  }

  it('lets a buyer join an external event community with no ticket', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me' });
    const e = await seedExternalEvent();
    // community auto-creation normally runs via EventService.publish; seed it
    // directly here since this test creates the Event via the model.
    await Community.create({ eventId: e._id, vendorId: e.vendorId });

    const view = await CommunityMembershipService.join(String(e._id), buyer as any);
    expect(view.membership).not.toBeNull();
  });

  it('never gates on ticket verification for an external event, even if a stray ticket exists', async () => {
    const PHONE = '+26878422614';
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me2' });
    const e = await seedExternalEvent();
    await Community.create({ eventId: e._id, vendorId: e.vendorId });

    // Data anomaly / legacy row: a Ticket happens to exist for this
    // event+phone even though externally-sold events never move Carrot
    // tickets. Joining an external event's community must not consult
    // ticket state at all — ticketVerified stays false regardless.
    await Ticket.create({
      eventId: String(e._id), vendorId: e.vendorId, ticketType: 'General',
      price: 100, customerPhone: PHONE, status: TicketStatus.SOLD,
    });

    const view = await CommunityMembershipService.join(String(e._id), buyer as any);
    expect(view.membership).not.toBeNull();
    expect(view.membership!.ticketVerified).toBe(false);
  });
});
