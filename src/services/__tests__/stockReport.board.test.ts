// src/services/__tests__/stockReport.board.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { MerchantCharge } from '@models/merchantCharge.model';

const eventId = new mongoose.Types.ObjectId();
let seq = 500000;

async function bar(name: string) { return Merchant.create({ name, eventId, loginCode: String(seq++), pin: '000000' } as any); }
async function prod(name: string, category = 'beer') { return Product.create({ eventId, name, category, price: 2500 } as any); }
async function stock(merchantId: any, productId: any, onHand: number, lowStockThreshold?: number) {
  return ProductStock.create({ eventId, merchantId, productId, onHand, ...(lowStockThreshold != null ? { lowStockThreshold } : {}) } as any);
}
/** An itemised tap at a bar — the only record that knows what a unit sold for. */
async function sale(merchantId: any, productId: any, name: string, qty: number, unitPrice: number) {
  return MerchantCharge.create({
    merchantId, merchantOperatorId: new mongoose.Types.ObjectId(), eventId,
    walletId: new mongoose.Types.ObjectId(), bandUid: '04AABBCC',
    amount: qty * unitPrice, fee: 0, netAmount: qty * unitPrice,
    clientTxnId: 'tap-' + seq++, status: 'completed', staffName: 'Bar Betty',
    items: [{ productId, name, unitPrice, qty, lineTotal: qty * unitPrice }],
  } as any);
}

describe('StockReportService.board', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('reports status per bar and aggregates per product', async () => {
    const b1 = await bar('Bar 1'); const b2 = await bar('Bar 2');
    const castle = await prod('Castle Lite'); const savanna = await prod('Savanna');
    await stock(b1._id, castle._id, 63);              // IN_STOCK
    await stock(b2._id, castle._id, 12, 20);          // LOW (12 <= 20)
    await stock(b1._id, savanna._id, 0, 5);           // SOLD_OUT

    const { perBar, byProduct } = await StockReportService.board(String(eventId));

    const castleB2 = perBar.find((r) => r.merchantName === 'Bar 2' && r.productName === 'Castle Lite')!;
    expect(castleB2.status).toBe('LOW');
    const savB1 = perBar.find((r) => r.productName === 'Savanna')!;
    expect(savB1.status).toBe('SOLD_OUT');

    const castleAgg = byProduct.find((p) => p.productName === 'Castle Lite')!;
    expect(castleAgg.totalOnHand).toBe(75);           // 63 + 12
    const savAgg = byProduct.find((p) => p.productName === 'Savanna')!;
    expect(savAgg.status).toBe('SOLD_OUT');           // total 0
  });

  it('never reads LOW when threshold is unset', async () => {
    const b1 = await bar('Bar 1'); const water = await prod('Water', 'water');
    await stock(b1._id, water._id, 1);                // no threshold
    const { perBar } = await StockReportService.board(String(eventId));
    expect(perBar[0]!.status).toBe('IN_STOCK');
    expect(perBar[0]!.lowStockThreshold).toBeNull();
  });

  it('reports what sold and what it made, next to what is left', async () => {
    const b1 = await bar('Bar 1'); const b2 = await bar('Bar 2');
    const castle = await prod('Castle Lite');
    await stock(b1._id, castle._id, 63);
    await stock(b2._id, castle._id, 31);
    await sale(b1._id, castle._id, 'Castle Lite', 20, 2500);
    await sale(b2._id, castle._id, 'Castle Lite', 10, 2500);

    const { perBar, byProduct } = await StockReportService.board(String(eventId));

    const atBar1 = perBar.find((r) => r.merchantName === 'Bar 1')!;
    expect(atBar1.unitsSold).toBe(20);
    expect(atBar1.revenue).toBe(50000);              // 20 x R25.00, in cents

    const castleAgg = byProduct.find((p) => p.productName === 'Castle Lite')!;
    expect(castleAgg.unitsSold).toBe(30);
    expect(castleAgg.revenue).toBe(75000);
    expect(castleAgg.totalOnHand).toBe(94);
  });

  it('reads zero sold rather than blank for a product nobody has bought', async () => {
    const b1 = await bar('Bar 1'); const ice = await prod('Ice', 'other');
    await stock(b1._id, ice._id, 40);

    const { perBar, byProduct } = await StockReportService.board(String(eventId));

    expect(perBar[0]!.unitsSold).toBe(0);
    expect(perBar[0]!.revenue).toBe(0);
    expect(byProduct[0]!.unitsSold).toBe(0);
  });

  it('still shows a product that sold at a bar carrying no stock row for it', async () => {
    const b1 = await bar('Pop-up Bar'); const shooter = await prod('Shooter');
    await sale(b1._id, shooter._id, 'Shooter', 4, 3000);

    const { byProduct } = await StockReportService.board(String(eventId));

    const row = byProduct.find((p) => p.productName === 'Shooter')!;
    expect(row.unitsSold).toBe(4);
    expect(row.revenue).toBe(12000);
    expect(row.totalOnHand).toBe(0);
  });
});
