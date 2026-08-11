import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

async function seed() {
  const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
  const rid = new mongoose.Types.ObjectId();
  const ev = await Event.create({
    vendorId: v._id, name: 'Farmers Market', venue: 'V',
    eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'General', price: 100, quantity: 50 },
      { name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100,
        resellerId: rid, isAllocation: true, allocationUnitCost: 250,
        restrictToMethod: PaymentMethod.DELTAPAY, waiveServiceFee: true },
    ],
  });
  const generalId = String(ev.ticketTypes.find((t) => t.name === 'General')!._id);
  const allocId = String(ev.ticketTypes.find((t) => t.isAllocation)!._id);
  return { ev, generalId, allocId };
}

describe('EventService.updateTicketsSold — allocation revenue attribution', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('counts allocation sales toward attendance/inventory but NOT organizer revenue', async () => {
    const { ev, allocId } = await seed();

    await EventService.updateTicketsSold(String(ev._id), allocId, 2, 520);

    const after = await Event.findById(ev._id);
    const tt = after!.ticketTypes.find((t) => String(t._id) === allocId)!;
    expect(tt.sold).toBe(2);              // inventory / sold-remaining
    expect(after!.totalTicketsSold).toBe(2); // attendance
    expect(after!.totalRevenue).toBe(0);  // organizer NOT credited
  });

  it('still credits organizer revenue for an ordinary tier', async () => {
    const { ev, generalId } = await seed();

    await EventService.updateTicketsSold(String(ev._id), generalId, 3, 300);

    const after = await Event.findById(ev._id);
    expect(after!.totalTicketsSold).toBe(3);
    expect(after!.totalRevenue).toBe(300);
  });
});
