import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { ProductStock } from '@models/productStock.model';
import { Product } from '@models/product.model';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { StockMovementReason as R } from '@interfaces/stock.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const oid = () => new mongoose.Types.ObjectId();
const at = (iso: string) => new Date(iso);
// The trading day 2 Oct 2026 in Eswatini: [00:00, 24:00) local = [Oct 1 22:00Z, Oct 2 22:00Z).
const FROM = at('2026-10-01T22:00:00Z');
const TO = at('2026-10-02T22:00:00Z');

async function seedVenue() {
  const venueId = oid();
  const stall = await Merchant.create({ name: 'Main Bar', venueId });
  const product = await Product.create({ name: 'Castle Lite', category: 'beer', price: 2500, venueId });
  const base = { venueId, merchantId: stall._id, productId: product._id, byType: 'Organizer', by: 'x' };
  return { venueId, stall, product, base };
}

describe('venue range reconciliation', () => {
  it('opens from the balance at the start of the day, closes on the balance at its end', async () => {
    const { venueId, base } = await seedVenue();
    const closingId = oid();
    await StockMovement.insertMany([
      { ...base, delta: 10, reason: R.RECEIVE, balanceAfter: 10, at: at('2026-10-01T07:00:00Z') }, // yesterday
      { ...base, delta: -2, reason: R.SALE, balanceAfter: 8, at: at('2026-10-01T18:00:00Z') },     // yesterday
      { ...base, delta: 5, reason: R.RECEIVE, balanceAfter: 13, at: at('2026-10-02T08:00:00Z') },
      { ...base, delta: -3, reason: R.SALE, balanceAfter: 10, at: at('2026-10-02T13:00:00Z') },
      { ...base, delta: -1, reason: R.COUNT_ADJUST, balanceAfter: 9, refType: 'stock_count', refId: String(closingId), at: at('2026-10-02T20:00:00Z') },
      { ...base, delta: 4, reason: R.RECEIVE, balanceAfter: 13, at: at('2026-10-03T07:00:00Z') },  // tomorrow
    ]);
    await StockCount.create({ ...base, _id: closingId, expectedOnHand: 10, countedOnHand: 9, variance: -1, phase: 'closing', at: at('2026-10-02T20:00:00Z') });
    await ProductStock.create({ venueId, merchantId: base.merchantId, productId: base.productId, onHand: 13 });

    const out = await StockReportService.reconciliation({ venueId }, { from: FROM, to: TO });
    expect(out.perBar).toHaveLength(1);
    expect(out.perBar[0]).toMatchObject({
      opening: 8, added: 5, sold: 3, countAdjust: -1, transferIn: 0, transferOut: 0,
      expectedClosing: 9, physicalCount: 9, variance: -1,
    });
    expect(out.total).toMatchObject({ opening: 8, added: 5, sold: 3, expectedClosing: 9 });
  });

  it('an opening count in the range is the baseline (its own adjustment excluded)', async () => {
    const { venueId, base } = await seedVenue();
    const openingId = oid();
    const closingId = oid();
    await StockMovement.insertMany([
      { ...base, delta: 10, reason: R.RECEIVE, balanceAfter: 10, at: at('2026-10-01T07:00:00Z') },
      { ...base, delta: -2, reason: R.SALE, balanceAfter: 8, at: at('2026-10-01T18:00:00Z') },
      { ...base, delta: -1, reason: R.COUNT_ADJUST, balanceAfter: 7, refType: 'stock_count', refId: String(openingId), at: at('2026-10-02T06:00:00Z') },
      { ...base, delta: 5, reason: R.RECEIVE, balanceAfter: 12, at: at('2026-10-02T08:00:00Z') },
      { ...base, delta: -3, reason: R.SALE, balanceAfter: 9, at: at('2026-10-02T13:00:00Z') },
      { ...base, delta: -1, reason: R.COUNT_ADJUST, balanceAfter: 8, refType: 'stock_count', refId: String(closingId), at: at('2026-10-02T20:00:00Z') },
    ]);
    await StockCount.create([
      { ...base, _id: openingId, expectedOnHand: 8, countedOnHand: 7, variance: -1, phase: 'opening', at: at('2026-10-02T06:00:00Z') },
      { ...base, _id: closingId, expectedOnHand: 9, countedOnHand: 8, variance: -1, phase: 'closing', at: at('2026-10-02T20:00:00Z') },
    ]);
    await ProductStock.create({ venueId, merchantId: base.merchantId, productId: base.productId, onHand: 8 });

    const out = await StockReportService.reconciliation({ venueId }, { from: FROM, to: TO });
    expect(out.perBar[0]).toMatchObject({
      opening: 7, added: 5, sold: 3, countAdjust: -1, expectedClosing: 8, physicalCount: 8, variance: -1,
    });
  });

  it('a stocked bar-product with no movement in the range still appears, carried at its balance', async () => {
    const { venueId, base } = await seedVenue();
    await StockMovement.create({ ...base, delta: 6, reason: R.RECEIVE, balanceAfter: 6, at: at('2026-09-30T10:00:00Z') });
    await ProductStock.create({ venueId, merchantId: base.merchantId, productId: base.productId, onHand: 6 });
    const out = await StockReportService.reconciliation({ venueId }, { from: FROM, to: TO });
    expect(out.perBar[0]).toMatchObject({ opening: 6, added: 0, sold: 0, expectedClosing: 6, physicalCount: null });
  });
});

describe('a venue never sees event sales', () => {
  it('board and dashboard ignore every event charge', async () => {
    await MerchantCharge.create({
      merchantId: oid(), eventId: oid(), walletId: oid(), bandUid: 'B1', amount: 2500, fee: 0, netAmount: 2500,
      clientTxnId: 'c1', status: 'completed', staffName: 'S',
      items: [{ productId: oid(), name: 'Coke', unitPrice: 2500, qty: 1, lineTotal: 2500 }],
    });
    const venueId = oid();
    expect(await StockReportService.board({ venueId })).toEqual({ perBar: [], byProduct: [] });
    const dash = await StockReportService.dashboard({ venueId });
    expect(dash.bestSellers).toEqual([]);
    expect(dash.salesByBar).toEqual([]);
  });
});
