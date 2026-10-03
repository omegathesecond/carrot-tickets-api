import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { StockTransfer } from '@models/stockTransfer.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 0;
async function ownedVenue() {
  seq += 1;
  const vendor = await Vendor.create({ businessName: `Lounge ${seq}`, email: `stock${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: `Lounge ${seq}`, currency: 'SZL', activatedBy: 'admin' });
  const token = signVendorToken(String(vendor._id), { permissions: [TicketsPermission.MANAGE_STOCK] });
  return { venueId: String(venue._id), auth: `Bearer ${token}` };
}
const CASTLE = { name: 'Castle Lite 330ml', category: 'beer', price: 2500, barcode: '6001240100015', unitsPerPack: 24, packLabel: 'case' };

describe('venue catalogue', () => {
  it("creates and lists products for its own venue only", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const created = await request(app).post('/api/tickets/venue/products').set('Authorization', a.auth).send(CASTLE);
    expect(created.status).toBe(201);
    expect(String((await Product.findById(created.body.data._id).lean())?.venueId)).toBe(a.venueId);
    await Product.create({ ...CASTLE, venueId: b.venueId, barcode: '6001240100099' });
    const list = await request(app).get('/api/tickets/venue/products').set('Authorization', a.auth);
    expect(list.body.data.map((p: { name: string }) => p.name)).toEqual(['Castle Lite 330ml']);
  });

  it('the same barcode at two venues is fine; twice in one venue is refused', async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    expect((await request(app).post('/api/tickets/venue/products').set('Authorization', a.auth).send(CASTLE)).status).toBe(201);
    expect((await request(app).post('/api/tickets/venue/products').set('Authorization', b.auth).send(CASTLE)).status).toBe(201);
    const dup = await request(app).post('/api/tickets/venue/products').set('Authorization', a.auth).send(CASTLE);
    expect(dup.status).toBe(400);
    expect(dup.body.message).toBe('A product with that barcode already exists at this venue');
  });

  it("edits its own product; another venue's and the event route 404", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const mine = await Product.create({ ...CASTLE, venueId: a.venueId });
    const theirs = await Product.create({ ...CASTLE, venueId: b.venueId });
    const ok = await request(app).patch(`/api/tickets/venue/products/${mine._id}`).set('Authorization', a.auth).send({ price: 2700 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.price).toBe(2700);
    expect((await request(app).patch(`/api/tickets/venue/products/${theirs._id}`).set('Authorization', a.auth).send({ price: 1 })).status).toBe(404);
    expect((await request(app).patch(`/api/tickets/products/${mine._id}`).set('Authorization', a.auth).send({ price: 1 })).status).toBe(404);
    expect((await Product.findById(theirs._id).lean())?.price).toBe(2500);
  });
});

describe('venue stock operations', () => {
  async function stallAndProduct(v: { venueId: string }) {
    const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
    const store = await Merchant.create({ name: 'Store Room', venueId: v.venueId });
    const product = await Product.create({ ...CASTLE, venueId: v.venueId });
    return { stall, store, product };
  }

  it('receives cases into a stall; the row and the journal entry are venue-owned', async () => {
    const v = await ownedVenue();
    const { stall, product } = await stallAndProduct(v);
    const res = await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', v.auth)
      .send({ merchantId: String(stall._id), productId: String(product._id), quantity: 2, unit: 'pack' });
    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(48);
    const row = await ProductStock.findOne({ merchantId: stall._id, productId: product._id }).lean();
    expect(String(row?.venueId)).toBe(v.venueId);
    expect(row?.eventId).toBeUndefined();
    const move = await StockMovement.findOne({ merchantId: stall._id }).lean();
    expect(String(move?.venueId)).toBe(v.venueId);
  });

  it("refuses another venue's stall", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const { product } = await stallAndProduct(a);
    const theirStall = await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    const res = await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', a.auth)
      .send({ merchantId: String(theirStall._id), productId: String(product._id), quantity: 1, unit: 'unit' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('merchant does not belong to this venue');
  });

  it('transfers between its stalls, counts, sets a threshold and allocations', async () => {
    const v = await ownedVenue();
    const { stall, store, product } = await stallAndProduct(v);
    const pid = String(product._id);
    await request(app).post('/api/tickets/venue/stock/receive').set('Authorization', v.auth)
      .send({ merchantId: String(store._id), productId: pid, quantity: 24, unit: 'unit' });

    const moved = await request(app).post('/api/tickets/venue/stock/transfer').set('Authorization', v.auth)
      .send({ productId: pid, fromMerchantId: String(store._id), toMerchantId: String(stall._id), qty: 10 });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ fromOnHand: 14, toOnHand: 10 });
    expect(String((await StockTransfer.findOne({ productId: product._id }).lean())?.venueId)).toBe(v.venueId);

    const counted = await request(app).post('/api/tickets/venue/stock/count').set('Authorization', v.auth)
      .send({ merchantId: String(stall._id), productId: pid, countedOnHand: 9, phase: 'closing' });
    expect(counted.status).toBe(200);
    expect(counted.body.data).toMatchObject({ expectedOnHand: 10, countedOnHand: 9, variance: -1 });
    expect(String((await StockCount.findOne({ merchantId: stall._id }).lean())?.venueId)).toBe(v.venueId);

    const thr = await request(app).patch('/api/tickets/venue/stock/threshold').set('Authorization', v.auth)
      .send({ merchantId: String(stall._id), productId: pid, lowStockThreshold: 5 });
    expect(thr.status).toBe(200);

    const newStall = await Merchant.create({ name: 'Patio', venueId: v.venueId });
    const alloc = await request(app).put('/api/tickets/venue/stock/allocations').set('Authorization', v.auth)
      .send({ productId: pid, merchantIds: [String(stall._id), String(store._id), String(newStall._id)] });
    expect(alloc.status).toBe(200);
    const patioRow = await ProductStock.findOne({ merchantId: newStall._id }).lean();
    expect(String(patioRow?.venueId)).toBe(v.venueId);
    const list = await request(app).get('/api/tickets/venue/stock/allocations').set('Authorization', v.auth);
    expect(list.body.data.allocations[pid]).toHaveLength(3);
  });
});
