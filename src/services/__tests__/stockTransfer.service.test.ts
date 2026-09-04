// src/services/__tests__/stockTransfer.service.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockTransferService } from '@services/stockTransfer.service';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { ProductStock } from '@models/productStock.model';
import { StockTransfer } from '@models/stockTransfer.model';

const eventId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const from = new mongoose.Types.ObjectId();
const to = new mongoose.Types.ObjectId();
const seedArgs = (extra: any) => ({ eventId: String(eventId), productId: String(productId), fromMerchantId: String(from), toMerchantId: String(to), byType: 'Organizer' as const, by: 'v1', ...extra });

async function receive(merchantId: mongoose.Types.ObjectId, qty: number) {
  await StockService.applyMovement({ eventId, merchantId, productId, delta: qty, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
}

describe('StockTransferService.transfer', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('moves qty from source to dest and records a StockTransfer', async () => {
    await receive(from, 100);
    const { transfer, fromOnHand, toOnHand } = await StockTransferService.transfer(seedArgs({ qty: 30 }));
    expect(fromOnHand).toBe(70);
    expect(toOnHand).toBe(30);
    expect((await ProductStock.findOne({ merchantId: from, productId }))!.onHand).toBe(70);
    expect((await ProductStock.findOne({ merchantId: to, productId }))!.onHand).toBe(30);
    expect(await StockTransfer.countDocuments({ _id: transfer._id })).toBe(1);
  });

  it('declines an over-transfer and moves nothing', async () => {
    await receive(from, 10);
    await expect(StockTransferService.transfer(seedArgs({ qty: 50 }))).rejects.toBeInstanceOf(StockDeclinedError);
    expect((await ProductStock.findOne({ merchantId: from, productId }))!.onHand).toBe(10); // untouched
    expect(await ProductStock.countDocuments({ merchantId: to, productId })).toBe(0);       // dest never created
    expect(await StockTransfer.countDocuments({})).toBe(0);
  });

  it('rejects a same-bar transfer', async () => {
    await receive(from, 100);
    await expect(StockTransferService.transfer(seedArgs({ qty: 5, toMerchantId: String(from) }))).rejects.toThrow(/same/i);
  });
});
