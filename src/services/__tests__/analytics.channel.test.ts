import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { AnalyticsService } from '@services/analytics.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function sale(channel: SalesChannel, amount: number) {
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: amount,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel,
    soldAt: new Date(),
  });
}

describe('getSalesStats channel filter', () => {
  it('filters by channel when provided', async () => {
    await sale(SalesChannel.ONLINE, 100);
    await sale(SalesChannel.ONLINE, 200);
    await sale(SalesChannel.BOX_OFFICE, 50);

    const stats = await AnalyticsService.getSalesStats({
      vendorId: '',
      isSuperAdmin: true,
      channel: SalesChannel.ONLINE,
    });

    expect(stats.totalSales).toBe(2);
    expect(stats.totalRevenue).toBe(300);
  });
});

describe('getDashboardStats channel filter', () => {
  it('filters sales block by channel when provided', async () => {
    await sale(SalesChannel.ONLINE, 100);
    await sale(SalesChannel.ONLINE, 200);
    await sale(SalesChannel.BOX_OFFICE, 50);

    const stats = await AnalyticsService.getDashboardStats({
      vendorId: '',
      isSuperAdmin: true,
      channel: SalesChannel.ONLINE,
    });

    expect(stats.sales.totalSales).toBe(2);
    expect(stats.tickets.totalRevenue).toBe(300);
  });
});

describe('getRevenueStats revenueByChannel', () => {
  it('aggregates revenue + count per channel', async () => {
    await sale(SalesChannel.ONLINE, 100);
    await sale(SalesChannel.ONLINE, 50);
    await sale(SalesChannel.BOX_OFFICE, 30);

    const stats = await AnalyticsService.getRevenueStats({ vendorId: '', isSuperAdmin: true });
    const online = stats.revenueByChannel.find((c) => c.channel === 'online');
    const box = stats.revenueByChannel.find((c) => c.channel === 'box_office');
    expect(online).toEqual({ channel: 'online', amount: 150, count: 2 });
    expect(box).toEqual({ channel: 'box_office', amount: 30, count: 1 });
  });

  it('honours the channel filter', async () => {
    await sale(SalesChannel.ONLINE, 100);
    await sale(SalesChannel.BOX_OFFICE, 30);

    const stats = await AnalyticsService.getRevenueStats({
      vendorId: '', isSuperAdmin: true, channel: SalesChannel.ONLINE,
    });
    expect(stats.revenueByChannel).toEqual([{ channel: 'online', amount: 100, count: 1 }]);
  });
});
