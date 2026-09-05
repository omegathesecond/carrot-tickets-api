// GET /api/merchant/stock must return ONLY products this stall carries — i.e.
// products with a ProductStock row for its merchantId. Before this task it
// returned every active product at the event with onHand 0, so the Shisanyama
// handheld listed the bar's spirits as sold-out tiles.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 940001;

const tokenFor = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId, operatorName: 'Nomsa Shongwe',
    eventId, name: 'Stall',
    permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);

async function seedStall(eventId: string, name: string) {
  const merchant = await Merchant.create({ name, eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111', grants: [OperatorGrant.MANAGE_STOCK],
  });
  return {
    merchantId: String(merchant._id),
    auth: `Bearer ${tokenFor(String(merchant._id), String(eventId), String(operator._id))}`,
  };
}

async function seedProduct(eventId: string, name: string) {
  const p = await Product.create({
    eventId, name, category: 'beer', price: 2500, unitLabel: 'unit', active: true,
  });
  return String(p._id);
}

/** Allocation IS a ProductStock row — that is the whole model. */
async function allocate(merchantId: string, productId: string, eventId: string, onHand = 0) {
  await ProductStock.create({ merchantId, productId, eventId, onHand });
}

it('returns only the products allocated to this stall', async () => {
  const { eventId } = await seedPublishedEvent({});
  const bar = await seedStall(String(eventId), 'Bar');
  const chicken = await seedProduct(String(eventId), 'Quarter Chicken');
  const beer = await seedProduct(String(eventId), 'Castle Lite 330ml');
  await allocate(bar.merchantId, beer, String(eventId), 12);

  const res = await request(app).get('/api/merchant/stock').set('Authorization', bar.auth);

  expect(res.status).toBe(200);
  expect(res.body.data.stock).toHaveLength(1);
  expect(res.body.data.stock[0].productId).toBe(beer);
  expect(res.body.data.stock[0].onHand).toBe(12);
  // The unallocated product must be ABSENT, not present at zero.
  expect(res.body.data.stock.map((s: { productId: string }) => s.productId)).not.toContain(chicken);
});

it('gives two stalls at one event disjoint catalogues', async () => {
  const { eventId } = await seedPublishedEvent({});
  const bar = await seedStall(String(eventId), 'Bar');
  const shisanyama = await seedStall(String(eventId), 'Shisanyama');
  const beer = await seedProduct(String(eventId), 'Castle Lite 330ml');
  const chicken = await seedProduct(String(eventId), 'Quarter Chicken');
  await allocate(bar.merchantId, beer, String(eventId), 5);
  await allocate(shisanyama.merchantId, chicken, String(eventId), 7);

  const barRes = await request(app).get('/api/merchant/stock').set('Authorization', bar.auth);
  const shiRes = await request(app).get('/api/merchant/stock').set('Authorization', shisanyama.auth);

  expect(barRes.body.data.stock.map((s: { name: string }) => s.name)).toEqual(['Castle Lite 330ml']);
  expect(shiRes.body.data.stock.map((s: { name: string }) => s.name)).toEqual(['Quarter Chicken']);
});

it('returns an empty list for a stall with no allocations, not the whole catalogue', async () => {
  const { eventId } = await seedPublishedEvent({});
  const stall = await seedStall(String(eventId), 'New Stall');
  await seedProduct(String(eventId), 'Castle Lite 330ml');

  const res = await request(app).get('/api/merchant/stock').set('Authorization', stall.auth);

  expect(res.status).toBe(200);
  expect(res.body.data.stock).toEqual([]);
});

it('still hides an inactive product even when it is allocated', async () => {
  const { eventId } = await seedPublishedEvent({});
  const stall = await seedStall(String(eventId), 'Bar');
  const beer = await seedProduct(String(eventId), 'Castle Lite 330ml');
  await Product.updateOne({ _id: beer }, { $set: { active: false } });
  await allocate(stall.merchantId, beer, String(eventId), 9);

  const res = await request(app).get('/api/merchant/stock').set('Authorization', stall.auth);

  expect(res.body.data.stock).toEqual([]);
});
