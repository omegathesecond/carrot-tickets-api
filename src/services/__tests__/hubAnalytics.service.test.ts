// api/src/services/__tests__/hubAnalytics.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedOperator } from '../../__tests__/helpers/fixtures';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { HubAnalyticsService } from '@services/hubAnalytics.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function sale(opts: {
  resellerId: string; hubId: string; soldBy: string;
  amount: number; qty: number; status?: PaymentStatus; soldAt?: Date;
}) {
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: Array.from({ length: opts.qty }, () => new mongoose.Types.ObjectId()),
    quantity: opts.qty,
    totalAmount: opts.amount,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: opts.status ?? PaymentStatus.COMPLETED,
    soldBy: new mongoose.Types.ObjectId(opts.soldBy),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(opts.resellerId),
    hubId: new mongoose.Types.ObjectId(opts.hubId),
    soldAt: opts.soldAt ?? new Date(),
  });
}

it('aggregates KPIs and per-operator stats for completed sales only', async () => {
  const a = await seedOperator({ loginCode: '900001' });
  const b = await seedOperator({ resellerId: a.resellerId, hubId: a.hubId, loginCode: '900002' });

  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: a.operator._id.toString(), amount: 100, qty: 2 });
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: a.operator._id.toString(), amount: 50, qty: 1 });
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: b.operator._id.toString(), amount: 200, qty: 4 });
  // A pending sale must be excluded.
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: b.operator._id.toString(), amount: 999, qty: 9, status: PaymentStatus.PENDING });

  const res = await HubAnalyticsService.getHubAnalytics(a.hubId);

  expect(res.revenue).toBe(350);          // 100+50+200, pending excluded
  expect(res.ticketsSold).toBe(7);        // 2+1+4
  expect(res.salesCount).toBe(3);
  expect(res.operatorsCount).toBe(2);

  const byA = res.byOperator.find((o) => o.operatorId === a.operator._id.toString())!;
  const byB = res.byOperator.find((o) => o.operatorId === b.operator._id.toString())!;
  expect(byA.revenue).toBe(150);
  expect(byA.salesCount).toBe(2);
  expect(byA.loginCode).toBe('900001');
  expect(byB.revenue).toBe(200);
  expect(byB.ticketsSold).toBe(4);
});

it('includes zero-sales operators and respects the date range', async () => {
  const a = await seedOperator({ loginCode: '900100' });
  const old = new Date('2020-01-01T00:00:00Z');
  await sale({ resellerId: a.resellerId, hubId: a.hubId, soldBy: a.operator._id.toString(), amount: 100, qty: 1, soldAt: old });

  // Range that excludes the 2020 sale.
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-12-31T23:59:59Z');
  const res = await HubAnalyticsService.getHubAnalytics(a.hubId, from, to);

  expect(res.revenue).toBe(0);
  expect(res.salesCount).toBe(0);
  expect(res.operatorsCount).toBe(1);
  expect(res.byOperator).toHaveLength(1);
  expect(res.byOperator[0]!.revenue).toBe(0); // zero-sales operator still listed
});
