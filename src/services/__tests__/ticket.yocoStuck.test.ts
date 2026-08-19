/**
 * reportStuckYocoSales — the visibility backstop for the one hole Yoco leaves.
 *
 * Peach and DeltaPay have reconcile sweeps that RESOLVE a stuck sale by asking
 * the provider. Yoco has no status-query endpoint, so nothing can resolve it
 * automatically. This job therefore does the only honest thing available: it
 * makes a stuck sale LOUD in the logs for manual recovery. It must never
 * silently fail (or silently complete) a sale to make the number go down.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketService } from '@services/ticket.service';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.restoreAllMocks();
});
afterAll(disconnectTestDb);

async function seedSale(p: {
  ageMs: number;
  status?: PaymentStatus;
  method?: PaymentMethod;
  checkoutId?: string | undefined;
}) {
  const vendorId = new mongoose.Types.ObjectId();
  const sale = await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId,
    ticketIds: [],
    quantity: 1,
    totalAmount: 50,
    amountCharged: 50,
    paymentMethod: p.method ?? PaymentMethod.YOCO,
    paymentStatus: p.status ?? PaymentStatus.PENDING,
    ...(p.checkoutId === undefined ? { yocoCheckoutId: 'ch_stuck' } : { yocoCheckoutId: p.checkoutId }),
    soldBy: vendorId,
    soldByType: 'Vendor',
    soldAt: new Date(),
  });
  // Backdate past the threshold. Must go through the RAW driver: Mongoose
  // refuses to rewrite `createdAt` on a timestamped schema even with
  // `{ timestamps: false }`, so a model-level updateOne silently no-ops here.
  await TicketSale.collection.updateOne(
    { _id: sale._id },
    { $set: { createdAt: new Date(Date.now() - p.ageMs) } }
  );
  return sale;
}

describe('reportStuckYocoSales', () => {
  it('reports a PENDING Yoco sale older than the threshold', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await seedSale({ ageMs: 30 * 60_000 });

    const n = await TicketService.reportStuckYocoSales();

    expect(n).toBe(1);
    expect(spy).toHaveBeenCalled();
  });

  it('NEVER changes the sale — a stuck sale must stay PENDING for manual recovery', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const sale = await seedSale({ ageMs: 30 * 60_000 });

    await TicketService.reportStuckYocoSales();

    const after = await TicketSale.findById(sale._id);
    expect(after!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('ignores a sale that is still inside the threshold', async () => {
    await seedSale({ ageMs: 60_000 });
    expect(await TicketService.reportStuckYocoSales()).toBe(0);
  });

  it('ignores an already-resolved Yoco sale', async () => {
    await seedSale({ ageMs: 30 * 60_000, status: PaymentStatus.COMPLETED });
    expect(await TicketService.reportStuckYocoSales()).toBe(0);
  });

  it('ignores other payment rails, which have their own reconcile sweeps', async () => {
    await seedSale({ ageMs: 30 * 60_000, method: PaymentMethod.DELTAPAY });
    expect(await TicketService.reportStuckYocoSales()).toBe(0);
  });

  it('ignores a sale that never reached Yoco (no checkout id)', async () => {
    await seedSale({ ageMs: 30 * 60_000, checkoutId: '' });
    expect(await TicketService.reportStuckYocoSales()).toBe(0);
  });
});
