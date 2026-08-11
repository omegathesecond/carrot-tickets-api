import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

async function seedRestrictedTier() {
  const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
  const ev = await Event.create({
    vendorId: v._id, name: 'Farmers Market', venue: 'V',
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100,
        resellerId: new mongoose.Types.ObjectId(), isAllocation: true,
        restrictToMethod: PaymentMethod.DELTAPAY },
      { name: 'General', price: 100, quantity: 50 },
    ],
  });
  return {
    eventId: String(ev._id),
    allocId: String(ev.ticketTypes.find((t) => t.isAllocation)!._id),
    generalId: String(ev.ticketTypes.find((t) => t.name === 'General')!._id),
  };
}

describe('checkTicketAvailability — per-tier payment-method restriction', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('rejects a restricted tier bought with the wrong method', async () => {
    const { eventId, allocId } = await seedRestrictedTier();
    const res = await EventService.checkTicketAvailability(eventId, allocId, 1, PaymentMethod.MTN_MOMO);
    expect(res.available).toBe(false);
    expect(res.message).toMatch(/deltapay/i);
  });

  it('allows the restricted tier with the required method', async () => {
    const { eventId, allocId } = await seedRestrictedTier();
    const res = await EventService.checkTicketAvailability(eventId, allocId, 1, PaymentMethod.DELTAPAY);
    expect(res.available).toBe(true);
  });

  it('leaves an unrestricted tier unaffected when a method is passed', async () => {
    const { eventId, generalId } = await seedRestrictedTier();
    const res = await EventService.checkTicketAvailability(eventId, generalId, 1, PaymentMethod.MTN_MOMO);
    expect(res.available).toBe(true);
  });

  it('does not enforce a restriction when no method is passed (back-compat)', async () => {
    const { eventId, allocId } = await seedRestrictedTier();
    const res = await EventService.checkTicketAvailability(eventId, allocId, 1);
    expect(res.available).toBe(true);
  });
});
