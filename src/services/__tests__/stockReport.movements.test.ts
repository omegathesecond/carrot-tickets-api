// src/services/__tests__/stockReport.movements.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { Waiter } from '@models/waiter.model';

const eventId = new mongoose.Types.ObjectId();
let seq = 530000;

async function bar(name: string) { return Merchant.create({ name, eventId, loginCode: String(seq++), pin: '000000' } as any); }
async function prod(name: string) { return Product.create({ eventId, name, category: 'beer', price: 100 } as any); }
async function move(merchantId: any, productId: any, delta: number) {
  return StockService.applyMovement({ eventId: String(eventId), merchantId: String(merchantId), productId: String(productId), delta, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);
}

describe('StockReportService.movements', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('pages newest-first via _id cursor and filters by product', async () => {
    const b = await bar('Bar 1');
    const a = await prod('A'); const bb = await prod('B');
    for (let i = 0; i < 3; i++) await move(b._id, a._id, 10);
    await move(b._id, bb._id, 5);

    const page1 = await StockReportService.movements({ eventId: String(eventId), limit: 2 });
    expect(page1.movements).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.movements[0]!.productName).toBeDefined();

    const page2 = await StockReportService.movements({ eventId: String(eventId), limit: 2, cursor: page1.nextCursor! });
    const ids1 = page1.movements.map((m) => m.id); const ids2 = page2.movements.map((m) => m.id);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);   // no overlap

    const onlyB = await StockReportService.movements({ eventId: String(eventId), productId: String(bb._id) });
    expect(onlyB.movements).toHaveLength(1);
    expect(onlyB.movements[0]!.productName).toBe('B');
  });

  // A waiter's `by` is a PERSON id, unlike an Organizer row's vendorId — so the
  // journal can and must name them. Without this the organizer's movement log
  // shows every waiter sale and line-removal as an unnamed row.
  it('names the waiter behind a Waiter-attributed movement', async () => {
    const b = await bar('Bar W');
    const p = await prod('W');
    const waiter = await Waiter.create({
      fullName: 'Thabo Dlamini', loginCode: 'WTRMOV1', pin: '123456', scope: 'organizer',
      vendorId: new mongoose.Types.ObjectId(), eventId,
    });
    await move(b._id, p._id, 10);
    await StockService.applyMovement({
      eventId: String(eventId), merchantId: String(b._id), productId: String(p._id),
      delta: -1, reason: StockMovementReason.SALE,
      byType: 'Waiter', by: String(waiter._id),
    } as any);

    const page = await StockReportService.movements({ eventId: String(eventId), productId: String(p._id), limit: 1 });
    expect(page.movements[0]!.byType).toBe('Waiter');
    expect(page.movements[0]!.byName).toBe('Thabo Dlamini');
  });
});
