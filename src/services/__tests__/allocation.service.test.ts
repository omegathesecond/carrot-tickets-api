import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { AllocationService } from '../allocation.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

const deltapay = new mongoose.Types.ObjectId();
const otherReseller = new mongoose.Types.ObjectId();

async function seed() {
  const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
  await Event.create({
    vendorId: v._id, name: 'Farmers Market', venue: 'V',
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'General', price: 100, quantity: 50, sold: 10 }, // organizer tier — must never appear
      { name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100, sold: 3, reserved: 0,
        resellerId: deltapay, isAllocation: true, restrictToMethod: PaymentMethod.DELTAPAY },
    ],
  });
  // A different reseller's block on another event — must be isolated out.
  await Event.create({
    vendorId: v._id, name: 'Other Event', venue: 'V2',
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'Other Exclusive', price: 200, quantity: 40, sold: 5, resellerId: otherReseller, isAllocation: true },
    ],
  });
}

describe('AllocationService.getForReseller', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns only the caller reseller\'s blocks with sold/remaining/collected', async () => {
    await seed();
    const { blocks } = await AllocationService.getForReseller(String(deltapay));

    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.eventName).toBe('Farmers Market');
    expect(b.tierName).toBe('General Ticket - DeltaPay Exclusive');
    expect(b.quantity).toBe(100);
    expect(b.sold).toBe(3);
    expect(b.remaining).toBe(97);
    expect(b.collected).toBe(780); // 3 × 260, face
  });

  it('isolates: a reseller never sees another reseller\'s block or the organizer tiers', async () => {
    await seed();
    const other = await AllocationService.getForReseller(String(otherReseller));
    expect(other.blocks).toHaveLength(1);
    expect(other.blocks[0]!.tierName).toBe('Other Exclusive');

    const none = await AllocationService.getForReseller(String(new mongoose.Types.ObjectId()));
    expect(none.blocks).toHaveLength(0);
  });
});
