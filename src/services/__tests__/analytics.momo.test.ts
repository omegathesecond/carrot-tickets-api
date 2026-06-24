/**
 * Task 9: analytics.momo.test.ts
 * Verifies that MTN MoMo is a first-class payment method in all three
 * AnalyticsService breakdowns:
 *   - getSalesStats.salesByPaymentMethod.momo
 *   - getDashboardStats.sales.momoSales / momoRevenue
 *   - getRevenueStats.revenueByPaymentMethod includes mtn_momo at runtime
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketSale } from '@models/ticketSale.model';
import { AnalyticsService } from '@services/analytics.service';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function createSale(paymentMethod: PaymentMethod, amount: number) {
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: amount,
    paymentMethod,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'Vendor',
    channel: SalesChannel.ONLINE,
    soldAt: new Date(),
  });
}

describe('getSalesStats: salesByPaymentMethod includes momo bucket', () => {
  it('populates momo count and revenue when MoMo sales exist', async () => {
    await createSale(PaymentMethod.CASH, 100);
    await createSale(PaymentMethod.MTN_MOMO, 200);
    await createSale(PaymentMethod.MTN_MOMO, 150);

    const stats = await AnalyticsService.getSalesStats({ vendorId: '', isSuperAdmin: true });

    expect(stats.salesByPaymentMethod.cash).toEqual({ count: 1, revenue: 100 });
    expect(stats.salesByPaymentMethod.momo).toEqual({ count: 2, revenue: 350 });
  });

  it('returns momo bucket zeroed when no MoMo sales exist', async () => {
    await createSale(PaymentMethod.CASH, 50);

    const stats = await AnalyticsService.getSalesStats({ vendorId: '', isSuperAdmin: true });

    expect(stats.salesByPaymentMethod.momo).toEqual({ count: 0, revenue: 0 });
  });
});

describe('getDashboardStats: sales includes momoSales / momoRevenue', () => {
  it('populates momoSales and momoRevenue when MoMo sales exist', async () => {
    await createSale(PaymentMethod.KESHLESS_WALLET, 80);
    await createSale(PaymentMethod.MTN_MOMO, 300);

    const stats = await AnalyticsService.getDashboardStats({ vendorId: '', isSuperAdmin: true });

    expect(stats.sales.momoSales).toBe(1);
    expect(stats.sales.momoRevenue).toBe(300);
    expect(stats.sales.walletSales).toBe(1);
    expect(stats.sales.totalSales).toBe(2);
  });

  it('returns momoSales=0 and momoRevenue=0 when no MoMo sales exist', async () => {
    await createSale(PaymentMethod.CASH, 50);

    const stats = await AnalyticsService.getDashboardStats({ vendorId: '', isSuperAdmin: true });

    expect(stats.sales.momoSales).toBe(0);
    expect(stats.sales.momoRevenue).toBe(0);
  });
});

describe('getRevenueStats: revenueByPaymentMethod includes mtn_momo at runtime', () => {
  it('includes mtn_momo entry when MoMo sales exist', async () => {
    await createSale(PaymentMethod.MTN_MOMO, 500);
    await createSale(PaymentMethod.CASH, 100);

    const stats = await AnalyticsService.getRevenueStats({ vendorId: '', isSuperAdmin: true });

    const momoEntry = stats.revenueByPaymentMethod.find((e) => e.method === 'mtn_momo');
    expect(momoEntry).toEqual({ method: 'mtn_momo', amount: 500, count: 1 });

    const cashEntry = stats.revenueByPaymentMethod.find((e) => e.method === 'cash');
    expect(cashEntry).toEqual({ method: 'cash', amount: 100, count: 1 });
  });
});
