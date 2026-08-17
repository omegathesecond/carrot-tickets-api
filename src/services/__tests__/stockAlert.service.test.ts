// src/services/__tests__/stockAlert.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockAlertService } from '@services/stockAlert.service';
import { ProductStock } from '@models/productStock.model';
import { Notification } from '@models/notification.model';

const eventId = new mongoose.Types.ObjectId();
const vendorId = new mongoose.Types.ObjectId();
const merchantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();

async function stock(onHand: number, lowStockThreshold: number | null, lowStockAlertedAt: Date | null = null) {
  await ProductStock.create({ eventId, merchantId, productId, onHand, lowStockThreshold, lowStockAlertedAt });
}

describe('StockAlertService', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('fires exactly one low_stock vendor notification when onHand crosses <= threshold', async () => {
    await stock(5, 20);
    await StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: String(vendorId), merchantId: String(merchantId), productIds: [String(productId)] });
    const notes = await Notification.find({ recipientType: 'vendor', recipientId: vendorId, type: 'low_stock' });
    expect(notes).toHaveLength(1);
    // armed: lowStockAlertedAt now set
    expect((await ProductStock.findOne({ merchantId, productId }))!.lowStockAlertedAt).not.toBeNull();

    // a second evaluation while still armed fires nothing more
    await StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: String(vendorId), merchantId: String(merchantId), productIds: [String(productId)] });
    expect(await Notification.countDocuments({ recipientId: vendorId, type: 'low_stock' })).toBe(1);
  });

  it('does not alert a product with no threshold', async () => {
    await stock(1, null);
    await StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: String(vendorId), merchantId: String(merchantId), productIds: [String(productId)] });
    expect(await Notification.countDocuments({ type: 'low_stock' })).toBe(0);
  });

  it('rearm clears the marker once onHand is back above threshold', async () => {
    await stock(50, 20, new Date());
    await StockAlertService.rearm(String(merchantId), String(productId));
    expect((await ProductStock.findOne({ merchantId, productId }))!.lowStockAlertedAt).toBeNull();
  });

  it('rearm does NOT clear while still at/below threshold', async () => {
    const t = new Date();
    await stock(10, 20, t);
    await StockAlertService.rearm(String(merchantId), String(productId));
    expect((await ProductStock.findOne({ merchantId, productId }))!.lowStockAlertedAt).not.toBeNull();
  });

  it('never throws even if notification creation fails', async () => {
    await stock(1, 20);
    // vendorId '' would make NotificationService.create throw on cast; evaluateAfterSale must swallow it
    await expect(StockAlertService.evaluateAfterSale({ eventId: String(eventId), vendorId: 'not-an-objectid', merchantId: String(merchantId), productIds: [String(productId)] })).resolves.toBeUndefined();
  });
});
