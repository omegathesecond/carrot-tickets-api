// src/services/__tests__/stockReport.board.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';

const eventId = new mongoose.Types.ObjectId();
let seq = 500000;

async function bar(name: string) { return Merchant.create({ name, eventId, loginCode: String(seq++), pin: '000000' } as any); }
async function prod(name: string, category = 'beer') { return Product.create({ eventId, name, category, price: 2500 } as any); }
async function stock(merchantId: any, productId: any, onHand: number, lowStockThreshold?: number) {
  return ProductStock.create({ eventId, merchantId, productId, onHand, ...(lowStockThreshold != null ? { lowStockThreshold } : {}) } as any);
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
});
