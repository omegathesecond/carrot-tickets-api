// src/routes/__tests__/stockAdmin.route.test.ts
// Harness copied verbatim from src/routes/__tests__/merchantCharge.route.test.ts:
//   app from '@/app', connectLedgerTestDb (routes use transactions),
//   signVendorToken(vendorId, { permissions }) and seedPublishedEvent() ->
//   { eventId, vendorId }. No new helpers are needed.
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginSeq = 900001;

/** A published cashless event + a MANAGE_STOCK owner token for its vendor. */
async function ownedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  return { eventId: String(eventId), vendorId: String(vendorId), token };
}

describe('stock admin routes', () => {
  it('creates and lists products for an owned event', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const create = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Castle Lite 330ml', category: 'beer', price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' });
    expect(create.status).toBe(201);
    expect(create.body.data.name).toBe('Castle Lite 330ml');

    const list = await request(app)
      .get(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('rejects a caller without MANAGE_STOCK', async () => {
    const { eventId, vendorId } = await ownedCashlessEvent();
    const token = signVendorToken(vendorId, { permissions: [] });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', category: 'other', price: 100 });
    expect(res.status).toBe(403);
  });

  it("forbids managing another vendor's event", async () => {
    const { token } = await ownedCashlessEvent();        // token for vendor A
    const other = await seedPublishedEvent({});           // event owned by vendor B
    const res = await request(app)
      .post(`/api/tickets/events/${other.eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', category: 'other', price: 100 });
    expect(res.status).toBe(403);
  });

  it('receives stock in packs and converts to base units', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const merchant = await Merchant.create({ name: 'Bar 4', eventId, loginCode: String(__loginSeq++), pin: '000000' });
    const product = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500, unitsPerPack: 24 });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: String(merchant._id), productId: String(product._id), quantity: 50, unit: 'pack' });
    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(1200); // 50 * 24
  });

  it('rejects receiving a product from a different event', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const merchant = await Merchant.create({ name: 'Bar 4', eventId, loginCode: String(__loginSeq++), pin: '000000' });
    const foreignProduct = await Product.create({ eventId: new mongoose.Types.ObjectId(), name: 'Nope', category: 'beer', price: 100 });
    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: String(merchant._id), productId: String(foreignProduct._id), quantity: 10 });
    expect(res.status).toBe(400);
  });

  it('updates a product (PATCH happy path)', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const create = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Castle Lite 330ml', category: 'beer', price: 2500 });
    expect(create.status).toBe(201);
    const productId = create.body.data._id;

    const patch = await request(app)
      .patch(`/api/tickets/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: 3000, name: 'Castle Lite 330ml (updated)' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.price).toBe(3000);
    expect(patch.body.data.name).toBe('Castle Lite 330ml (updated)');
  });

  it("forbids PATCHing a product belonging to another vendor's event", async () => {
    const { token } = await ownedCashlessEvent();        // token for vendor A
    const other = await seedPublishedEvent({});           // event owned by vendor B
    const foreignProduct = await Product.create({ eventId: other.eventId, name: 'Not Yours', category: 'beer', price: 100 });

    const patch = await request(app)
      .patch(`/api/tickets/products/${String(foreignProduct._id)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: 200 });
    expect(patch.status).toBe(403);
  });

  it('rejects a PATCH that collides on barcode with another product in the same event (400, not 500)', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const first = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500, barcode: '6001240100015' });
    const second = await Product.create({ eventId, name: 'Black Label', category: 'beer', price: 2500, barcode: '6001240100022' });

    const patch = await request(app)
      .patch(`/api/tickets/products/${String(second._id)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ barcode: String(first.barcode) });
    expect(patch.status).toBe(400);
  });

  it('rejects receiving in packs when the product has no pack size', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const merchant = await Merchant.create({ name: 'Bar 4', eventId, loginCode: String(__loginSeq++), pin: '000000' });
    const product = await Product.create({ eventId, name: 'Loose Ice', category: 'other', price: 50 }); // no unitsPerPack

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/stock/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({ merchantId: String(merchant._id), productId: String(product._id), quantity: 5, unit: 'pack' });
    expect(res.status).toBe(400);
  });

  it('rejects creating a product with a duplicate barcode in the same event (400, not 500)', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const first = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Castle Lite 330ml', category: 'beer', price: 2500, barcode: '6001240100015' });
    expect(first.status).toBe(201);

    const dupe = await request(app)
      .post(`/api/tickets/events/${eventId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Castle Lite 330ml (again)', category: 'beer', price: 2500, barcode: '6001240100015' });
    expect(dupe.status).toBe(400);
  });
});
