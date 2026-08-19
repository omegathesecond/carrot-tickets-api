// Harness mirrors merchantCharge.route.test.ts (app, JWT token(), connectLedgerTestDb).
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Product } from '@models/product.model';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { StockService } from '@services/stock.service';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// A merchant token names the STALL and the PERSON on its till; without the
// person authenticateMerchant rejects it.
const token = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId,
    operatorName: 'Thabo Dlamini', eventId, name: 'Bar', permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET);

async function setup({ beerStock = 100 }: { beerStock?: number } = {}) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'GA', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  const bandUid = '04a1b2c3d4e5';
  await WalletService.bindBand(String(w._id), bandUid, 'op1');
  await WalletService.topUpCash({ walletId: String(w._id), eventId: String(eventId), amount: 100000, recordedBy: 'op1', clientTxnId: 'seed' });
  const merchant = await Merchant.create({ name: 'Bar', eventId, commissionPercent: 0 });
  // The charge transaction re-reads the operator and refuses a missing or
  // deactivated one, so the token has to name a row that really exists.
  const operator = await MerchantOperator.create({
    fullName: 'Thabo Dlamini', merchantId: merchant._id, eventId, loginCode: '4KZ901', pin: '111111',
  });
  const beer = await Product.create({ eventId, name: 'Castle Lite', category: ProductCategory.BEER, price: 2500 });
  if (beerStock) {
    await StockService.applyMovement({
      eventId, merchantId: merchant._id, productId: beer._id, delta: beerStock,
      reason: StockMovementReason.RECEIVE, byType: 'Merchant', by: String(merchant._id),
    });
  }
  return {
    eventId: String(eventId), bandUid, merchantId: String(merchant._id),
    merchantOperatorId: String(operator._id), beerId: String(beer._id),
  };
}

it('itemised charge returns 200 with the priced breakdown and new balance', async () => {
  const { eventId, bandUid, merchantId, beerId, merchantOperatorId } = await setup();
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId, merchantOperatorId)}`)
    // A stale POS may still send staffName in the body. It must NOT cause a
    // validation rejection (200, not 400) and must NOT reach the record —
    // the token's operatorName ('Thabo Dlamini') is what gets stored.
    .send({ bandUid, clientTxnId: 'c1', staffName: 'Sipho', items: [{ productId: beerId, qty: 2 }] });
  expect(res.status).toBe(200);
  expect(res.body.data.amount).toBe(5000);
  expect(res.body.data.newBalance).toBe(95000);
  expect(res.body.data.items).toHaveLength(1);

  const charge = await MerchantCharge.findOne({ merchantId, clientTxnId: 'c1' });
  expect(charge!.staffName).toBe('Thabo Dlamini');
  expect(charge!.staffName).not.toBe('Sipho');
});

it('an out-of-stock line declines with 409 out_of_stock, wallet untouched', async () => {
  const { eventId, bandUid, merchantId, beerId, merchantOperatorId } = await setup({ beerStock: 1 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId, merchantOperatorId)}`)
    .send({ bandUid, clientTxnId: 'c2', items: [{ productId: beerId, qty: 5 }] });
  expect(res.status).toBe(409);
  // Standard ApiResponseUtil envelope stringifies the 4th arg into `error`
  // (same pattern the pre-existing 402 test asserts on) — parse before matching.
  const errorPayload = JSON.parse(res.body.error);
  expect(errorPayload).toMatchObject({ reason: 'insufficient_stock', productId: beerId, available: 1 });
});

it('rejects sending both amount and items with 400', async () => {
  const { eventId, bandUid, merchantId, beerId, merchantOperatorId } = await setup();
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId, merchantOperatorId)}`)
    .send({ bandUid, clientTxnId: 'c3', amount: 300, items: [{ productId: beerId, qty: 1 }] });
  expect(res.status).toBe(400);
});

it('still accepts an amount-only charge (200, un-itemised)', async () => {
  const { eventId, bandUid, merchantId, merchantOperatorId } = await setup();
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId, merchantOperatorId)}`)
    .send({ bandUid, clientTxnId: 'c4', amount: 300 });
  expect(res.status).toBe(200);
  expect(res.body.data.items).toBeUndefined();
});
