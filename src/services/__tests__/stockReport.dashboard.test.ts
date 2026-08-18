// src/services/__tests__/stockReport.dashboard.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';

const eventId = new mongoose.Types.ObjectId();
let seq = 520000;

async function bar(name: string) { return Merchant.create({ name, eventId, loginCode: String(seq++), pin: '000000' } as any); }
async function prod(name: string, category = 'beer') { return Product.create({ eventId, name, category, price: 2500 } as any); }

async function itemisedCharge(merchantId: any, productId: any, name: string, unitPrice: number, qty: number, staffName = 'Fixture Operator', clientTxnId = String(new mongoose.Types.ObjectId())) {
  const lineTotal = unitPrice * qty;
  return MerchantCharge.create({
    merchantId, merchantOperatorId: new mongoose.Types.ObjectId(), eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b1',
    amount: lineTotal, fee: 0, netAmount: lineTotal, clientTxnId, status: 'completed',
    items: [{ productId, name, unitPrice, qty, lineTotal }], staffName,
  } as any);
}
async function amountOnlyCharge(merchantId: any, amount: number, clientTxnId = String(new mongoose.Types.ObjectId()), legacy = false) {
  // NO items field at all — mirrors MerchantService.charge amount-only path (default:undefined).
  // `legacy: true` simulates a PRE-migration row that predates merchantOperatorId/staffName
  // becoming required — bypasses Mongoose validation the same way an old, untouched
  // document in the collection would, so the dashboard's $ifNull null-handling stays covered.
  // Model.create(doc, options) is NOT a valid single-doc overload in this
  // mongoose version (it resolves to the variadic multi-doc signature) — use
  // `new Model(doc).save(options)` to actually skip validation for `legacy`.
  const doc = new MerchantCharge({
    merchantId, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b2',
    amount, fee: 0, netAmount: amount, clientTxnId, status: 'completed',
    ...(legacy ? {} : { merchantOperatorId: new mongoose.Types.ObjectId(), staffName: 'Fixture Operator' }),
  } as any);
  return doc.save({ validateBeforeSave: !legacy });
}

describe('StockReportService.dashboard', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('splits itemised vs un-itemised by items.0 existence (not the items field)', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Castle Lite');
    await itemisedCharge(b._id, p._id, 'Castle Lite', 2500, 2);   // 5000 itemised
    await amountOnlyCharge(b._id, 1500);                          // 1500 un-itemised

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.itemisedSplit.itemised.gross).toBe(5000);
    expect(d.itemisedSplit.itemised.count).toBe(1);
    expect(d.itemisedSplit.unitemised.gross).toBe(1500);         // the amount-only charge
    expect(d.itemisedSplit.unitemised.count).toBe(1);
    expect(d.itemisedSplit.itemised.gross + d.itemisedSplit.unitemised.gross).toBe(6500);
    expect(d.revenueByProduct[0]).toMatchObject({ productName: 'Castle Lite', revenue: 5000, units: 2 });
  });

  it('groups sales by bar and by employee (null -> Unattributed)', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Savanna', 'wine');
    await itemisedCharge(b._id, p._id, 'Savanna', 3000, 1, 'Thandi');
    // legacy: true simulates a pre-migration row lacking staffName -> Unattributed.
    await amountOnlyCharge(b._id, 2000, undefined, true);

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.salesByBar[0]).toMatchObject({ merchantName: 'Bar 1', gross: 5000, count: 2 });
    const unattributed = d.salesByEmployee.find((e) => e.staffName === null)!;
    expect(unattributed.label).toBe('Unattributed');
    expect(unattributed.gross).toBe(2000);
    const thandi = d.salesByEmployee.find((e) => e.staffName === 'Thandi')!;
    expect(thandi.gross).toBe(3000);
  });

  it('orders best-sellers by units sold', async () => {
    const b = await bar('Bar 1');
    const a = await prod('Alpha'); const z = await prod('Zulu');
    await itemisedCharge(b._id, a._id, 'Alpha', 100, 5);   // 5 units, revenue 500
    await itemisedCharge(b._id, z._id, 'Zulu', 400, 2);    // 2 units, revenue 800

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.bestSellers[0]!.productName).toBe('Alpha');   // more units, despite lower revenue
    expect(d.revenueByProduct[0]!.productName).toBe('Zulu'); // more revenue
  });

  it('buckets peak selling times by Eswatini (UTC+2) hour', async () => {
    const b = await bar('Bar 1'); const p = await prod('Castle Lite');
    // A sale at 20:30 UTC is 22:30 in UTC+2 -> hour bucket 22.
    await StockMovement.create({ eventId, merchantId: b._id, productId: p._id, delta: -7, reason: 'sale', balanceAfter: 0, byType: 'Merchant', by: 'till', at: new Date('2026-08-13T20:30:00Z') } as any);

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.peakTimes).toHaveLength(24);
    expect(d.peakTimes.find((h) => h.hour === 22)!.units).toBe(7);
    expect(d.peakTimes.find((h) => h.hour === 20)!.units).toBe(0);
  });

  it('lists closing variances and totals shrinkage', async () => {
    const b = await bar('Bar 1'); const p = await prod('Savanna', 'wine');
    await StockCount.create({ eventId, merchantId: b._id, productId: p._id, expectedOnHand: 50, countedOnHand: 47, variance: -3, phase: 'closing', byType: 'Organizer', by: 'v1' } as any);

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.variances).toHaveLength(1);
    expect(d.variances[0]!).toMatchObject({ productName: 'Savanna', variance: -3 });
    expect(d.totalShrinkageUnits).toBe(-3);
  });

  it('predicts stock-out from the recent sales rate and skips products with no recent sales', async () => {
    const b = await bar('Bar 1');
    const fast = await prod('Fast Mover'); const idle = await prod('Idle');
    await ProductStock.create({ eventId, merchantId: b._id, productId: fast._id, onHand: 20 } as any);
    await ProductStock.create({ eventId, merchantId: b._id, productId: idle._id, onHand: 5 } as any);
    // 10 units sold in the last window -> rate 10/60 per min -> 20 / (10/60) = 120 min to zero.
    await StockMovement.create({ eventId, merchantId: b._id, productId: fast._id, delta: -10, reason: 'sale', balanceAfter: 20, byType: 'Merchant', by: 'till', at: new Date() } as any);

    const d = await StockReportService.dashboard(String(eventId));
    const pred = d.predictedStockOut.find((r) => r.productName === 'Fast Mover')!;
    expect(pred.minutesToStockOut).toBeCloseTo(120, 1);
    expect(d.predictedStockOut.find((r) => r.productName === 'Idle')).toBeUndefined(); // no recent sales -> excluded
    expect(d.noRecentSales).toBeGreaterThanOrEqual(1);
  });
});
