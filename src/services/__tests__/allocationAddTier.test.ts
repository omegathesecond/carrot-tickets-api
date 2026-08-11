import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

async function seedEvent() {
  const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
  const ev = await Event.create({
    vendorId: v._id, name: 'Farmers Market', venue: 'V',
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 50 }],
  });
  return { vendorId: String(v._id), eventId: String(ev._id) };
}

const rid = new mongoose.Types.ObjectId();

describe('EventService.addTicketType — allocation tier', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('persists allocation metadata when added by a super-admin', async () => {
    const { vendorId, eventId } = await seedEvent();

    const event = await EventService.addTicketType(eventId, vendorId, {
      name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100,
      resellerId: String(rid), isAllocation: true, allocationUnitCost: 250,
      restrictToMethod: PaymentMethod.DELTAPAY, waiveServiceFee: true,
    } as any, true);

    const tt = event.ticketTypes.find(t => t.isAllocation)!;
    expect(tt).toBeTruthy();
    expect(String(tt.resellerId)).toBe(String(rid));
    expect(tt.allocationUnitCost).toBe(250);
    expect(tt.restrictToMethod).toBe(PaymentMethod.DELTAPAY);
    expect(tt.waiveServiceFee).toBe(true);
    expect(tt.available).toBe(100);
  });

  it('FAILS LOUDLY when a non-super-admin tries to create an allocation tier', async () => {
    const { vendorId, eventId } = await seedEvent();
    await expect(
      EventService.addTicketType(eventId, vendorId, {
        name: 'Sneaky', price: 260, quantity: 100, resellerId: String(rid), isAllocation: true,
      } as any, false)
    ).rejects.toThrow(/super-admin/i);
  });

  it('FAILS LOUDLY when an allocation tier has no reseller', async () => {
    const { vendorId, eventId } = await seedEvent();
    await expect(
      EventService.addTicketType(eventId, vendorId, {
        name: 'NoReseller', price: 260, quantity: 100, isAllocation: true,
      } as any, true)
    ).rejects.toThrow(/reseller/i);
  });

  it('creates an ordinary tier normally (no allocation fields)', async () => {
    const { vendorId, eventId } = await seedEvent();
    const event = await EventService.addTicketType(eventId, vendorId, {
      name: 'VIP', price: 500, quantity: 20,
    } as any, false);
    const tt = event.ticketTypes.find(t => t.name === 'VIP')!;
    expect(tt.isAllocation).toBeUndefined();
    expect(tt.resellerId).toBeUndefined();
  });
});
