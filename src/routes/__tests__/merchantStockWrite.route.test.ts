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
import { StockMovement } from '@models/stockMovement.model';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 930001;

export const token = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId, operatorName: 'Nomsa Shongwe',
    eventId, name: 'Sandwich Stall', permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);

/** A stall, a person on it, and a 24-per-case product. `grants` decides the job. */
async function seedStall(opts: { grants?: OperatorGrant[]; onHand?: number } = {}) {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111',
    grants: opts.grants ?? [OperatorGrant.MANAGE_STOCK],
  });
  const product = await Product.create({
    eventId, name: 'Castle Lite 330ml', category: ProductCategory.BEER,
    price: 2500, unitLabel: 'bottle', unitsPerPack: 24, packLabel: 'case',
    barcode: '6001240100015',
  });
  if (opts.onHand != null) {
    await ProductStock.create({ eventId, merchantId: merchant._id, productId: product._id, onHand: opts.onHand });
  }
  return {
    eventId: String(eventId),
    merchantId: String(merchant._id),
    merchantOperatorId: String(operator._id),
    productId: String(product._id),
    auth: `Bearer ${token(String(merchant._id), String(eventId), String(operator._id))}`,
  };
}

describe('POST /api/merchant/stock/receive', () => {
  it('adds a delivery in cases and journals it against the operator', async () => {
    const s = await seedStall({ onHand: 10 });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, quantity: 5, unit: 'pack', note: 'Friday delivery' });

    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(130); // 10 + 5*24

    const move = await StockMovement.findOne({ merchantId: s.merchantId, reason: StockMovementReason.RECEIVE }).lean();
    expect(move).toMatchObject({ delta: 120, balanceAfter: 130, byType: 'Merchant', by: s.merchantOperatorId });
  });

  it('defaults to base units when no unit is given', async () => {
    const s = await seedStall({ onHand: 0 });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 7 });
    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(7);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [], onHand: 0 });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 1 });
    expect(res.status).toBe(403);
  });

  it('refuses a product from another event', async () => {
    const s = await seedStall({ onHand: 0 });
    const other = await seedPublishedEvent({});
    const foreign = await Product.create({
      eventId: other.eventId, name: 'Foreign Cola', category: ProductCategory.SOFT_DRINK,
      price: 1800, unitLabel: 'can',
    });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: String(foreign._id), quantity: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses packs on a product with no pack size', async () => {
    const s = await seedStall({ onHand: 0 });
    const ice = await Product.create({
      eventId: s.eventId, name: 'Ice 2kg', category: ProductCategory.OTHER,
      price: 2000, unitLabel: 'bag',
    });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth).send({ productId: String(ice._id), quantity: 2, unit: 'pack' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pack size/i);
  });

  it('refuses a body that names another stall — scope is the token, not the payload', async () => {
    const s = await seedStall({ onHand: 0 });
    const otherStall = await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });
    const res = await request(app).post('/api/merchant/stock/receive')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, quantity: 3, merchantId: String(otherStall._id) });

    // posStockAdjustSchema declares no merchantId and Joi rejects unknown keys,
    // so this fails loudly instead of quietly writing to the caller's own stall.
    expect(res.status).toBe(400);
    const theirs = await ProductStock.findOne({ merchantId: otherStall._id, productId: s.productId }).lean();
    expect(theirs).toBeNull();
  });
});

describe('POST /api/merchant/stock/waste', () => {
  it('writes off breakage and lands as spoilage in the journal', async () => {
    const s = await seedStall({ onHand: 40 });
    const res = await request(app).post('/api/merchant/stock/waste')
      .set('Authorization', s.auth)
      .send({ productId: s.productId, quantity: 6, note: 'crate dropped' });

    expect(res.status).toBe(200);
    expect(res.body.data.onHand).toBe(34);

    const move = await StockMovement.findOne({ merchantId: s.merchantId, reason: StockMovementReason.SPOILAGE }).lean();
    expect(move).toMatchObject({ delta: -6, balanceAfter: 34, byType: 'Merchant', by: s.merchantOperatorId, note: 'crate dropped' });
  });

  it('refuses to write off more than is on hand, leaving the balance untouched', async () => {
    const s = await seedStall({ onHand: 3 });
    const res = await request(app).post('/api/merchant/stock/waste')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 4 });

    expect(res.status).toBe(409);
    const payload = JSON.parse(res.body.error);
    expect(payload).toMatchObject({ reason: 'insufficient_stock', productId: s.productId, available: 3 });

    const row = await ProductStock.findOne({ merchantId: s.merchantId, productId: s.productId }).lean();
    expect(row?.onHand).toBe(3);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [], onHand: 10 });
    const res = await request(app).post('/api/merchant/stock/waste')
      .set('Authorization', s.auth).send({ productId: s.productId, quantity: 1 });
    expect(res.status).toBe(403);
  });
});
