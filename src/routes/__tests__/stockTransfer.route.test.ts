// src/routes/__tests__/stockTransfer.route.test.ts
// Harness mirrors stockAdmin.route.test.ts / stockThreshold.route.test.ts
// (app, signVendorToken, seedPublishedEvent, connectLedgerTestDb — this route
// runs a multi-document transaction, so it needs the replica-set harness).
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 620001;

/** A published cashless event + a MANAGE_STOCK owner token, two bars, and one
 *  product with 100 on hand at bar A. */
async function owned() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  const barA = await Merchant.create({ name: 'Bar A', eventId, loginCode: String(seq++), pin: '000000' });
  const barB = await Merchant.create({ name: 'Bar B', eventId, loginCode: String(seq++), pin: '000000' });
  const product = await Product.create({ eventId, name: 'Beer', category: 'beer', price: 2500 });
  await StockService.applyMovement({
    eventId, merchantId: barA._id, productId: product._id, delta: 100,
    reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1',
  });
  return { eventId: String(eventId), token, barAId: String(barA._id), barBId: String(barB._id), productId: String(product._id) };
}

describe('stock transfer route', () => {
  it('transfers stock from bar A to bar B (200)', async () => {
    const { eventId, token, barAId, barBId, productId } = await owned();
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, fromMerchantId: barAId, toMerchantId: barBId, qty: 30 });
    expect(res.status).toBe(200);
    expect(res.body.data.fromOnHand).toBe(70);
    expect(res.body.data.toOnHand).toBe(30);
    expect(res.body.data.transferId).toBeTruthy();
  });

  it('declines an over-transfer (409)', async () => {
    const { eventId, token, barAId, barBId, productId } = await owned();
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, fromMerchantId: barAId, toMerchantId: barBId, qty: 500 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects a same-bar transfer (400)', async () => {
    const { eventId, token, barAId, productId } = await owned();
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, fromMerchantId: barAId, toMerchantId: barAId, qty: 5 });
    expect(res.status).toBe(400);
  });

  it("rejects a merchant that belongs to another event (400)", async () => {
    const { eventId, token, barBId, productId } = await owned();
    const foreignMerchant = await Merchant.create({ name: 'Foreign Bar', eventId: new mongoose.Types.ObjectId(), loginCode: String(seq++), pin: '000000' });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, fromMerchantId: String(foreignMerchant._id), toMerchantId: barBId, qty: 5 });
    expect(res.status).toBe(400);
  });

  it('requires MANAGE_STOCK', async () => {
    const { eventId, barAId, barBId, productId } = await owned();
    const token = signVendorToken(String(new mongoose.Types.ObjectId()), { permissions: [] });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, fromMerchantId: barAId, toMerchantId: barBId, qty: 5 });
    expect(res.status).toBe(403);
  });
});
