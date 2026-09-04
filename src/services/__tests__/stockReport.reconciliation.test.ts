// src/services/__tests__/stockReport.reconciliation.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { StockService } from '@services/stock.service';
import { StockCountService } from '@services/stockCount.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';

const eventId = new mongoose.Types.ObjectId();
const startTime = new Date('2026-08-13T18:00:00Z');   // doors open
let seq = 510000;

async function bar(name: string) { return Merchant.create({ name, eventId, loginCode: String(seq++), pin: '000000' } as any); }
async function prod(name: string, category = 'beer') { return Product.create({ eventId, name, category, price: 2500 } as any); }

async function receive(merchantId: any, productId: any, delta: number, at: Date) {
  // applyMovement stamps at = Date.now(); write then backdate for the split test.
  const { movement } = await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(merchantId), productId: String(productId),
    delta, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1',
  } as any);
  await StockMovement.updateOne({ _id: movement._id }, { $set: { at } });
}

describe('StockReportService.reconciliation', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('splits opening vs added on startTime and derives expected == onHand', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Castle Lite');
    await receive(b._id, p._id, 100, new Date('2026-08-13T15:00:00Z'));   // pre-doors -> opening
    await receive(b._id, p._id, 40, new Date('2026-08-13T20:00:00Z'));    // post-doors -> added
    await StockService.applyMovement({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), delta: -30, reason: StockMovementReason.SALE, byType: 'Merchant', by: 'till', refId: 'c1' } as any);

    const { perBar, total } = await StockReportService.reconciliation(String(eventId), startTime);
    const row = perBar[0]!;
    expect(row.opening).toBe(100);
    expect(row.added).toBe(40);
    expect(row.sold).toBe(30);
    expect(row.expectedClosing).toBe(110);            // onHand = 100 + 40 - 30
    expect(row.opening + row.added + row.transferIn - row.sold - row.transferOut + row.countAdjust - row.spoilage + row.manual)
      .toBe(row.expectedClosing);
    expect(total.sold).toBe(30);
  });

  it('takes physical + variance from the latest closing count', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Savanna', 'wine');
    await receive(b._id, p._id, 50, new Date('2026-08-13T15:00:00Z'));
    // physical count finds 45 (5 short) -> closing StockCount variance -5, count_adjust -5
    await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), countedOnHand: 45, phase: 'closing', byType: 'Organizer', by: 'v1' } as any);

    const { perBar } = await StockReportService.reconciliation(String(eventId), startTime);
    const row = perBar[0]!;
    expect(row.physicalCount).toBe(45);
    expect(row.variance).toBe(-5);
    expect(row.countAdjust).toBe(-5);
    expect(row.expectedClosing).toBe(45);             // book reconciled to reality
  });

  it('keeps rollup physical/variance null when NO bar has a closing count', async () => {
    const b1 = await bar('Bar 1'); const b2 = await bar('Bar 2');
    const p = await prod('Castle Lite');
    await receive(b1._id, p._id, 60, new Date('2026-08-13T15:00:00Z'));
    await receive(b2._id, p._id, 40, new Date('2026-08-13T15:00:00Z'));   // neither bar counted

    const { perBar, byProduct, total } = await StockReportService.reconciliation(String(eventId), startTime);
    expect(perBar.every((r) => r.physicalCount === null && r.variance === null)).toBe(true);
    expect(byProduct[0]!.physicalCount).toBeNull();   // NOT 0 — "not counted", not "counted zero"
    expect(byProduct[0]!.variance).toBeNull();
    expect(total.physicalCount).toBeNull();
    expect(total.variance).toBeNull();
    expect(byProduct[0]!.expectedClosing).toBe(100);  // 60 + 40 across both bars
  });

  it('rolls up physical/variance from the counted bars only', async () => {
    const b1 = await bar('Bar 1'); const b2 = await bar('Bar 2');
    const p = await prod('Savanna', 'wine');
    await receive(b1._id, p._id, 50, new Date('2026-08-13T15:00:00Z'));
    await receive(b2._id, p._id, 50, new Date('2026-08-13T15:00:00Z'));
    await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(b1._id), productId: String(p._id), countedOnHand: 45, phase: 'closing', byType: 'Organizer', by: 'v1' } as any);   // only b1 counted (5 short)

    const { byProduct, total } = await StockReportService.reconciliation(String(eventId), startTime);
    expect(byProduct[0]!.physicalCount).toBe(45);     // only b1 contributes; b2 (uncounted) is excluded, not 0
    expect(byProduct[0]!.variance).toBe(-5);
    expect(total.physicalCount).toBe(45);
    expect(total.variance).toBe(-5);
  });

  // An OPENING count is the baseline the row reconciles against. Its own
  // count_adjust (counted − expected) is already inside `opening`, so summing
  // it into countAdjust as well applies the same units twice and reports
  // phantom shrinkage on a bar that is exactly right.
  it("does not double-count an opening count's variance: received 100, opening count 95, sold 30 -> expected 65, variance 0", async () => {
    const b = await bar('Bar 1');
    const p = await prod('Castle Lite');
    await receive(b._id, p._id, 100, new Date('2026-08-13T15:00:00Z'));   // pre-doors receive
    // Opening stock-take finds 95: count_adjust -5, and 95 becomes `opening`.
    await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), countedOnHand: 95, phase: 'opening', byType: 'Organizer', by: 'v1' } as any);
    await StockService.applyMovement({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), delta: -30, reason: StockMovementReason.SALE, byType: 'Merchant', by: 'till', refId: 'c1' } as any);

    const { perBar } = await StockReportService.reconciliation(String(eventId), startTime);
    const row = perBar[0]!;
    expect(row.opening).toBe(95);
    expect(row.sold).toBe(30);
    expect(row.countAdjust).toBe(0);                  // the -5 is INSIDE `opening`, not on top of it
    expect(row.expectedClosing).toBe(65);             // onHand = 100 - 5 - 30
    expect(row.opening + row.added + row.transferIn - row.sold - row.transferOut + row.countAdjust - row.spoilage + row.manual)
      .toBe(row.expectedClosing);

    // A closing count that finds exactly 65 is NO shrinkage.
    await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), countedOnHand: 65, phase: 'closing', byType: 'Organizer', by: 'v1' } as any);
    const after = (await StockReportService.reconciliation(String(eventId), startTime)).perBar[0]!;
    expect(after.physicalCount).toBe(65);
    expect(after.variance).toBe(0);
    expect(after.expectedClosing).toBe(65);
    expect(after.countAdjust).toBe(0);
    expect(after.opening + after.added + after.transferIn - after.sold - after.transferOut + after.countAdjust - after.spoilage + after.manual)
      .toBe(after.expectedClosing);
  });

  // Everything BEFORE the opening count is folded into it (that is what a
  // baseline means), and everything after it — including a pre-doors receive —
  // reconciles against it. Otherwise a top-up between the count and doors
  // vanishes from the row and the identity breaks again.
  it('with an opening count, movements before it fold into `opening` and receives after it are `added` even pre-doors', async () => {
    const b = await bar('Bar 1');
    const p = await prod('Castle Lite');
    await receive(b._id, p._id, 100, new Date('2026-08-13T16:00:00Z'));   // 16:00 receive
    const { count } = await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), countedOnHand: 95, phase: 'opening', byType: 'Organizer', by: 'v1' } as any);
    const countAt = new Date('2026-08-13T17:00:00Z');                       // 17:00 opening count (adjust -5)
    await StockCount.updateOne({ _id: count._id }, { $set: { at: countAt } });
    await StockMovement.updateOne({ refType: 'stock_count', refId: String(count._id) }, { $set: { at: countAt } });
    await receive(b._id, p._id, 20, new Date('2026-08-13T17:30:00Z'));    // 17:30 receive: AFTER the count, BEFORE doors
    await StockService.applyMovement({ eventId: String(eventId), merchantId: String(b._id), productId: String(p._id), delta: -30, reason: StockMovementReason.SALE, byType: 'Merchant', by: 'till', refId: 'c1' } as any);

    const { perBar, total } = await StockReportService.reconciliation(String(eventId), startTime);
    const row = perBar[0]!;
    expect(row.opening).toBe(95);
    expect(row.added).toBe(20);
    expect(row.sold).toBe(30);
    expect(row.countAdjust).toBe(0);
    expect(row.expectedClosing).toBe(85);             // onHand = 100 - 5 + 20 - 30
    expect(row.opening + row.added + row.transferIn - row.sold - row.transferOut + row.countAdjust - row.spoilage + row.manual)
      .toBe(row.expectedClosing);
    expect(total.expectedClosing).toBe(85);
  });
});
