// Task 6b: proves the two mapper-style accounting endpoints now surface the
// event's display currency on their per-event items, instead of silently
// dropping it (which made the dashboard fall back to 'SZL'/'E' for ZAR events).
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { ResellerReportService } from '@services/resellerReport.service';
import { AllocationService } from '@services/allocation.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('ResellerReportService.listSales — currency', () => {
  const resellerId = new mongoose.Types.ObjectId();

  async function seedSale(currency?: 'SZL' | 'ZAR') {
    await TicketSale.create({
      eventId: new mongoose.Types.ObjectId(),
      vendorId: new mongoose.Types.ObjectId(),
      ticketIds: [new mongoose.Types.ObjectId()],
      quantity: 1,
      totalAmount: 100,
      ...(currency ? { currency } : {}),
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.COMPLETED,
      soldBy: new mongoose.Types.ObjectId(),
      soldByType: 'ResellerOperator',
      resellerId,
      soldAt: new Date(),
    });
  }

  it('carries the sale\'s ZAR currency onto the mapped row', async () => {
    await seedSale('ZAR');
    const { sales } = await ResellerReportService.listSales({
      scope: { resellerId: resellerId.toString(), role: 'reseller_admin' },
    });
    expect(sales).toHaveLength(1);
    expect(sales[0]!.currency).toBe('ZAR');
  });

  it('defaults to SZL when the sale has no currency snapshot', async () => {
    await seedSale();
    const { sales } = await ResellerReportService.listSales({
      scope: { resellerId: resellerId.toString(), role: 'reseller_admin' },
    });
    expect(sales).toHaveLength(1);
    expect(sales[0]!.currency).toBe('SZL');
  });
});

describe('AllocationService.getForReseller — currency', () => {
  const deltapay = new mongoose.Types.ObjectId();

  it('carries the event\'s ZAR currency onto the allocation block', async () => {
    const v = await Vendor.create({ businessName: 'Farmers', password: 'password123', slug: 'farmers' });
    await Event.create({
      vendorId: v._id, name: 'Cross-Border Fest', venue: 'V', currency: 'ZAR',
      eventDate: new Date(Date.now() + 86400000), startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [
        { name: 'Exclusive', price: 260, quantity: 100, sold: 3, reserved: 0,
          resellerId: deltapay, isAllocation: true, restrictToMethod: PaymentMethod.DELTAPAY },
      ],
    });

    const { blocks } = await AllocationService.getForReseller(String(deltapay));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.currency).toBe('ZAR');
  });
});
