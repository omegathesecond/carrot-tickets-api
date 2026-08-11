import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

describe('ticketType allocation fields', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('persists allocation metadata and defaults non-allocation tiers to undefined', async () => {
    const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
    const rid = new mongoose.Types.ObjectId();
    const ev = await Event.create({
      vendorId: v._id,
      name: 'Farmers Market',
      venue: 'V',
      eventDate: new Date(Date.now() + 86400000),
      startTime: new Date(Date.now() + 86400000),
      endTime: new Date(Date.now() + 90000000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [
        { name: 'General', price: 100, quantity: 50 },
        {
          name: 'General Ticket - DeltaPay Exclusive',
          price: 260,
          quantity: 100,
          resellerId: rid,
          isAllocation: true,
          allocationUnitCost: 250,
          restrictToMethod: PaymentMethod.DELTAPAY,
          waiveServiceFee: true,
        },
      ],
    });

    const plain = ev.ticketTypes.find((t) => t.name === 'General')!;
    const alloc = ev.ticketTypes.find((t) => t.isAllocation)!;
    expect(plain.isAllocation).toBeUndefined();
    expect(String(alloc.resellerId)).toBe(String(rid));
    expect(alloc.allocationUnitCost).toBe(250);
    expect(alloc.restrictToMethod).toBe(PaymentMethod.DELTAPAY);
    expect(alloc.waiveServiceFee).toBe(true);
  });
});
