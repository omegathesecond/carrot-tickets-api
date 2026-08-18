// src/routes/__tests__/stockCount.route.test.ts
// Organizer harness mirrors stockTransfer.route.test.ts (app, signVendorToken,
// seedPublishedEvent, connectLedgerTestDb). POS harness mirrors
// merchantChargeItems.route.test.ts (app, JWT token(), connectLedgerTestDb).
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason, ProductCategory } from '@interfaces/stock.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 640001;

describe('organizer stock count route', () => {
  /** A published cashless event + a MANAGE_STOCK owner token, one bar, and one
   *  product with 100 on hand. */
  async function owned() {
    const { eventId, vendorId } = await seedPublishedEvent({});
    await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
    const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
    const bar = await Merchant.create({ name: 'Bar A', eventId, loginCode: String(seq++), pin: '000000' });
    const product = await Product.create({ eventId, name: 'Beer', category: ProductCategory.BEER, price: 2500 });
    await StockService.applyMovement({
      eventId, merchantId: bar._id, productId: product._id, delta: 100,
      reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1',
    });
    return { eventId: String(eventId), token, barId: String(bar._id), productId: String(product._id) };
  }

  it('records a count with variance and reconciles onHand (200)', async () => {
    const { eventId, token, barId, productId } = await owned();
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/count`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: barId, productId, countedOnHand: 92 });
    expect(res.status).toBe(200);
    expect(res.body.data.expectedOnHand).toBe(100);
    expect(res.body.data.variance).toBe(-8);
    expect(res.body.data.onHand).toBe(92);
    expect((await ProductStock.findOne({ merchantId: barId, productId }))!.onHand).toBe(92);
  });

  it("rejects a merchant that belongs to another event (400)", async () => {
    const { eventId, token, productId } = await owned();
    const foreignMerchant = await Merchant.create({ name: 'Foreign Bar', eventId: new mongoose.Types.ObjectId(), loginCode: String(seq++), pin: '000000' });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/count`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: String(foreignMerchant._id), productId, countedOnHand: 10 });
    expect(res.status).toBe(400);
  });

  it('requires MANAGE_STOCK', async () => {
    const { eventId, barId, productId } = await owned();
    const token = signVendorToken(String(new mongoose.Types.ObjectId()), { permissions: [] });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/count`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: barId, productId, countedOnHand: 10 });
    expect(res.status).toBe(403);
  });
});

describe('POS stock routes', () => {
  // A merchant token names the STALL and the PERSON on its till; without the
  // person authenticateMerchant rejects it.
  const merchantToken = (merchantId: string, eventId: string) =>
    jwt.sign({
      scope: 'merchant', merchantId, merchantOperatorId: new mongoose.Types.ObjectId().toString(),
      operatorName: 'Thabo Dlamini', eventId, name: 'Bar', permissions: [MerchantPermission.CHARGE],
    }, JWT_SECRET);

  async function setup() {
    const { eventId } = await seedPublishedEvent({});
    await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
    const barA = await Merchant.create({ name: 'Bar A', eventId, loginCode: String(seq++), pin: '000000' });
    const barB = await Merchant.create({ name: 'Bar B', eventId, loginCode: String(seq++), pin: '000000' });
    const product = await Product.create({ eventId, name: 'Beer', category: ProductCategory.BEER, price: 2500 });
    // Seed stock ONLY under bar A's merchantId.
    await StockService.applyMovement({
      eventId, merchantId: barA._id, productId: product._id, delta: 100,
      reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1',
    });
    return { eventId: String(eventId), barAId: String(barA._id), barBId: String(barB._id), productId: String(product._id) };
  }

  it("GET /api/merchant/stock returns this bar's products with onHand", async () => {
    const { eventId, barAId, productId } = await setup();
    const res = await request(app)
      .get('/api/merchant/stock')
      .set('Authorization', `Bearer ${merchantToken(barAId, eventId)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stock).toEqual([
      expect.objectContaining({ productId, name: 'Beer', onHand: 100 }),
    ]);
  });

  it('GET /api/merchant/stock carries price/barcode/category + a computed status', async () => {
    const { eventId } = await seedPublishedEvent({});
    await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
    const bar = await Merchant.create({ name: 'Bar A', eventId, loginCode: String(seq++), pin: '000000' });
    // low: onHand 3 <= threshold 5
    const beer = await Product.create({ eventId, name: 'Castle Lite', category: ProductCategory.BEER, price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' });
    await ProductStock.create({ eventId, merchantId: bar._id, productId: beer._id, onHand: 3, lowStockThreshold: 5 });
    // sold_out: onHand 0. barcodeless (food) -> barcode null.
    const ice = await Product.create({ eventId, name: 'Ice', category: ProductCategory.OTHER, price: 1000 });
    await ProductStock.create({ eventId, merchantId: bar._id, productId: ice._id, onHand: 0 });

    const res = await request(app)
      .get('/api/merchant/stock')
      .set('Authorization', `Bearer ${merchantToken(String(bar._id), String(eventId))}`);
    expect(res.status).toBe(200);
    const rows: any[] = res.body.data.stock;
    const beerRow = rows.find((r) => r.productId === String(beer._id));
    expect(beerRow).toMatchObject({ price: 2500, barcode: '6001240100015', category: 'beer', unitsPerPack: 24, packLabel: 'case', onHand: 3, lowStockThreshold: 5, status: 'low' });
    const iceRow = rows.find((r) => r.productId === String(ice._id));
    expect(iceRow).toMatchObject({ price: 1000, category: 'other', onHand: 0, status: 'sold_out' });
    expect(iceRow.barcode).toBeNull();
  });

  it('POST /api/merchant/stock/count is scoped to the TOKEN\'s merchant', async () => {
    const { eventId, barAId, barBId, productId } = await setup();
    // Bar B has no stock row at all; a count by Bar B's token must reconcile
    // BAR B's stock (0 -> 40), never touch Bar A's 100.
    const res = await request(app)
      .post('/api/merchant/stock/count')
      .set('Authorization', `Bearer ${merchantToken(barBId, eventId)}`)
      .send({ productId, countedOnHand: 40 });
    expect(res.status).toBe(200);
    expect(res.body.data.expectedOnHand).toBe(0);
    expect(res.body.data.variance).toBe(40);
    expect(res.body.data.onHand).toBe(40);

    expect((await ProductStock.findOne({ merchantId: barBId, productId }))!.onHand).toBe(40);
    expect((await ProductStock.findOne({ merchantId: barAId, productId }))!.onHand).toBe(100); // untouched
  });

  it('POST /api/merchant/stock/count rejects a product from another event (400)', async () => {
    const { eventId, barAId } = await setup();
    const { eventId: otherEventId } = await seedPublishedEvent({});
    const foreignProduct = await Product.create({ eventId: otherEventId, name: 'Foreign', category: ProductCategory.BEER, price: 1000 });
    const res = await request(app)
      .post('/api/merchant/stock/count')
      .set('Authorization', `Bearer ${merchantToken(barAId, eventId)}`)
      .send({ productId: String(foreignProduct._id), countedOnHand: 5 });
    expect(res.status).toBe(400);
  });
});
