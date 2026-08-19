// src/routes/__tests__/stockThreshold.route.test.ts
// Harness mirrors stockAdmin.route.test.ts (app, signVendorToken, seedPublishedEvent, connectLedgerTestDb).
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 610001;
async function owned() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  const merchant = await Merchant.create({ name: 'Bar', eventId, loginCode: String(seq++), pin: '000000' });
  const product = await Product.create({ eventId, name: 'Beer', category: 'beer', price: 2500 });
  return { eventId: String(eventId), token, merchantId: String(merchant._id), productId: String(product._id) };
}

it('sets a threshold (upsert) and re-arms', async () => {
  const { eventId, token, merchantId, productId } = await owned();
  await ProductStock.create({ eventId, merchantId, productId, onHand: 3, lowStockAlertedAt: new Date() });
  const res = await request(app).patch(`/api/tickets/events/${eventId}/stock/threshold`)
    .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, lowStockThreshold: 20 });
  expect(res.status).toBe(200);
  const row = await ProductStock.findOne({ merchantId, productId });
  expect(row!.lowStockThreshold).toBe(20);
  expect(row!.lowStockAlertedAt).toBeNull(); // re-armed
});

it('requires MANAGE_STOCK', async () => {
  const { eventId, merchantId, productId } = await owned();
  const token = signVendorToken(String(new (require('mongoose').Types.ObjectId)()), { permissions: [] });
  const res = await request(app).patch(`/api/tickets/events/${eventId}/stock/threshold`)
    .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, lowStockThreshold: 20 });
  expect(res.status).toBe(403);
});
