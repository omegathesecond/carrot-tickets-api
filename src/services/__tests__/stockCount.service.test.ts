// src/services/__tests__/stockCount.service.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockCountService } from '@services/stockCount.service';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ProductStock } from '@models/productStock.model';
import { StockCount } from '@models/stockCount.model';
import { StockMovement } from '@models/stockMovement.model';

const eventId = new mongoose.Types.ObjectId();
const merchantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const args = (extra: any) => ({ eventId: String(eventId), merchantId: String(merchantId), productId: String(productId), phase: 'interim' as const, byType: 'Organizer' as const, by: 'v1', ...extra });

describe('StockCountService.recordCount', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('records a shortfall: counted<expected → negative variance + COUNT_ADJUST to counted', async () => {
    await StockService.applyMovement({ eventId, merchantId, productId, delta: 100, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
    const { count } = await StockCountService.recordCount(args({ countedOnHand: 92 }));
    expect(count.expectedOnHand).toBe(100);
    expect(count.variance).toBe(-8);
    expect((await ProductStock.findOne({ merchantId, productId }))!.onHand).toBe(92); // reconciled to reality
    expect(await StockMovement.countDocuments({ merchantId, productId, reason: StockMovementReason.COUNT_ADJUST })).toBe(1);
  });

  it('records a zero-variance count with NO movement', async () => {
    await StockService.applyMovement({ eventId, merchantId, productId, delta: 50, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
    const { count } = await StockCountService.recordCount(args({ countedOnHand: 50 }));
    expect(count.variance).toBe(0);
    expect(await StockMovement.countDocuments({ merchantId, productId, reason: StockMovementReason.COUNT_ADJUST })).toBe(0);
    expect(await StockCount.countDocuments({})).toBe(1); // still recorded
  });
});
