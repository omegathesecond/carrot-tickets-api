import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { LedgerService } from '@services/ledger.service';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { MerchantService } from '@services/merchant.service';
import { WalletService } from '@services/wallet.service';
import { StockService } from '@services/stock.service';
import { StockReportService } from '@services/stockReport.service';
import { OrganizerCashlessService } from '@services/organizerCashless.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { StockMovementReason } from '@interfaces/stock.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
afterAll(disconnectTestDb);

async function setup(itemised = false) {
  const { eventId } = await seedPublishedEvent();
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true, purchaseCharge: { type: 'fixed', value: 400 } } });
  const merchant = await Merchant.create({ eventId, name: 'Test bar', commissionPercent: 10 });
  const operator = await MerchantOperator.create({ eventId, merchantId: merchant._id, fullName: 'Alex', loginCode: String(new mongoose.Types.ObjectId()), pin: '123456' });
  const wallet = await Wallet.create({ eventId, bandUid: 'aabbccdd' });
  for (const [method, amount] of [['cash', 4000], ['card', 6000]] as const) await WalletService.topUpAtDesk({ walletId: String(wallet._id), eventId, method, amount, recordedBy: String(operator._id), recordedByType: 'ResellerOperator', clientTxnId: method });
  const params = { merchantId: String(merchant._id), merchantOperatorId: String(operator._id), eventId, walletId: String(wallet._id), bandUid: 'aabbccdd', operatorName: 'Alex', clientTxnId: 'sale', quotedTotal: 3400 };
  let product;
  if (itemised) {
    product = await Product.create({ eventId, name: 'Water', category: 'water', price: 1500 });
    await StockService.applyMovement({ eventId, merchantId: String(merchant._id), productId: product._id, delta: 10, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: String(operator._id) });
  }
  const result = await MerchantService.charge({ ...params, ...(product ? { items: [{ productId: String(product._id), qty: 2 }] } : { amount: 3000 }) });
  const token = jwt.sign({ scope: 'merchant', ...params, permissions: ['merchant:charge'] }, JWT_SECRET);
  return { eventId, merchant, operator, wallet, product, charge: result.charge, token, params };
}
const reverse = (s: Awaited<ReturnType<typeof setup>>, body: object = {}, token = s.token) => request(app).post(`/api/merchant/transactions/${s.charge._id}/reverse`).set('Authorization', `Bearer ${token}`).send({ bandUid: 'aabbccdd', pin: '123456', reason: 'Wrong amount', restock: false, ...body });

it('balance is event-scoped, read-only, normalizes the band and exposes no customer history', async () => {
  const s = await setup();
  const count = await LedgerEntry.countDocuments();
  const res = await request(app).get('/api/merchant/balance?bandUid=AABBCCDD').set('Authorization', `Bearer ${s.token}`);
  expect(res.status).toBe(200); expect(res.body.data).toEqual({ balance: 6600, status: 'active', bandUid: 'aabbccdd' });
  expect(await LedgerEntry.countDocuments()).toBe(count);
  const { eventId } = await seedPublishedEvent();
  await Wallet.create({ eventId, bandUid: '11223344', balance: 999 });
  expect((await request(app).get('/api/merchant/balance?bandUid=11223344').set('Authorization', `Bearer ${s.token}`)).status).toBe(404);
  expect((await request(app).get('/api/merchant/balance?bandUid=aabbccdd&eventId=other').set('Authorization', `Bearer ${s.token}`)).status).toBe(400);
});

it('returns the complete stored total and funding split, reverses fees and organizer charges, and leaves float intact', async () => {
  const s = await setup();
  expect(s.charge.cashFundedAmount).toBe(3400);
  await Event.updateOne({ _id: s.eventId }, { $set: { purchaseCharge: { type: 'percentage', value: 50 } } });
  await Merchant.updateOne({ _id: s.merchant._id }, { $set: { commissionPercent: 90 } });
  const res = await reverse(s);
  expect(res.status).toBe(200); expect(res.body.data).toMatchObject({ amount: 3400, newBalance: 10000, status: 'reversed', reversal: { staffName: 'Alex', reason: 'Wrong amount', restocked: false } });
  const wallet = await Wallet.findById(s.wallet._id); expect(wallet).toMatchObject({ balance: 10000, cashFundedBalance: 4000 });
  const report = await ReconciliationService.checkInvariant(s.eventId);
  expect(report).toMatchObject({ ok: true, drift: 0, float: 10000, walletsOwed: 10000, merchantsOwed: 0, organizerOwed: 0, feesEarned: 0 });
  expect((await MerchantService.listTransactions({ merchantId: String(s.merchant._id) })).summary).toEqual({ totalCharged: 0, totalNet: 0, totalFee: 0, count: 0 });
  expect(await OrganizerCashlessService.summary(s.eventId)).toMatchObject({ spent: 0, purchaseCharges: 0, fees: 0 });
  expect((await WalletService.getWalletViewByBand('aabbccdd', s.eventId))!.history.some(h => h.type === 'reversal' && h.amount === 3400)).toBe(true);
});

it('supports the existing percentage charge configuration and excludes cancelled revenue', async () => {
  const s = await setup();
  await reverse(s);
  await Event.updateOne({ _id: s.eventId }, { $set: { purchaseCharge: { type: 'percentage', value: 12.5 } } });
  const second = await MerchantService.charge({ ...s.params, clientTxnId: 'percent-sale', amount: 800, quotedTotal: 900 });
  s.charge = second.charge;
  expect((await reverse(s)).body.data.amount).toBe(900);
  expect(await OrganizerCashlessService.summary(s.eventId)).toMatchObject({ spent: 0, purchaseCharges: 0 });
});

it('restores the original funding portion after other purchases have used the remaining cash', async () => {
  const s = await setup();
  await MerchantService.charge({ ...s.params, amount: 2000, quotedTotal: 2400, clientTxnId: 'second' });
  expect((await Wallet.findById(s.wallet._id))!.cashFundedBalance).toBe(0);
  expect((await reverse(s)).status).toBe(200);
  expect(await Wallet.findById(s.wallet._id)).toMatchObject({ balance: 7600, cashFundedBalance: 3400 });
  expect((await ReconciliationService.checkInvariant(s.eventId)).ok).toBe(true);
});

it('concurrent retries refund and restock exactly once, with stock and earnings reports agreeing', async () => {
  const s = await setup(true);
  await ProductStock.updateOne({ productId: s.product!._id }, { $set: { lowStockThreshold: 9, lowStockAlertedAt: new Date() } });
  const responses = await Promise.all([reverse(s, { restock: true }), reverse(s, { restock: true })]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(await Wallet.findById(s.wallet._id)).toMatchObject({ balance: 10000, cashFundedBalance: 4000 });
  expect(await ProductStock.findOne({ productId: s.product!._id })).toMatchObject({ onHand: 10, lowStockAlertedAt: null });
  expect(await StockMovement.countDocuments({ reason: 'sale_reversal' })).toBe(1);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_reversal' })).toBe(4);
  expect((await StockReportService.board(s.eventId)).perBar[0]).toMatchObject({ onHand: 10, unitsSold: 0, revenue: 0 });
  expect((await StockReportService.reconciliation(s.eventId, new Date(Date.now() + 60_000))).perBar[0]).toMatchObject({ sold: 0, expectedClosing: 10 });
  expect((await StockReportService.dashboard(s.eventId)).salesByBar).toEqual([]);
  expect((await reverse(s, { reason: 'A different request', restock: true })).status).toBe(409);
});

it('can return money without returning already-consumed items to stock', async () => {
  const s = await setup(true);
  expect((await reverse(s)).status).toBe(200);
  expect(await ProductStock.findOne({ productId: s.product!._id })).toMatchObject({ onHand: 8 });
  expect(await StockMovement.countDocuments({ reason: 'sale_reversal' })).toBe(0);
});

it('rolls all writes back if a stock return fails', async () => {
  const s = await setup(true);
  jest.spyOn(StockService, 'applyMovement').mockRejectedValueOnce(new Error('Stock unavailable'));
  expect((await reverse(s, { restock: true })).status).toBe(500);
  expect(await Wallet.findById(s.wallet._id)).toMatchObject({ balance: 6600, cashFundedBalance: 600 });
  expect((await MerchantCharge.findById(s.charge._id))!.status).toBe('completed');
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_reversal' })).toBe(0);
});

it('rolls the refund and stock return back if the ledger fails', async () => {
  const s = await setup(true);
  jest.spyOn(LedgerService, 'post').mockRejectedValueOnce(new Error('Ledger unavailable'));
  expect((await reverse(s, { restock: true })).status).toBe(500);
  expect(await Wallet.findById(s.wallet._id)).toMatchObject({ balance: 6600, cashFundedBalance: 600 });
  expect(await ProductStock.findOne({ productId: s.product!._id })).toMatchObject({ onHand: 8 });
  expect((await MerchantCharge.findById(s.charge._id))!.status).toBe('completed');
  expect(await StockMovement.countDocuments({ reason: 'sale_reversal' })).toBe(0);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_reversal' })).toBe(0);
});

it('requires the original band even when a replacement band now owns the wallet', async () => {
  const s = await setup();
  await Wallet.updateOne({ _id: s.wallet._id }, { $set: { bandUid: '11223344' } });
  expect((await reverse(s, { bandUid: '11223344' })).status).toBe(409);
  expect((await reverse(s)).status).toBe(409);
  expect(await Wallet.findById(s.wallet._id)).toMatchObject({ balance: 6600, cashFundedBalance: 600 });
});

it('rejects another customer band, inactive wallets, and malformed stock choices', async () => {
  const s = await setup();
  await Wallet.create({ eventId: s.eventId, bandUid: '11223344' });
  expect((await reverse(s, { bandUid: '11223344' })).status).toBe(409);
  expect((await reverse(s, { restock: 'false' })).status).toBe(400);
  expect((await reverse(s, { restock: true })).status).toBe(400);
  await Wallet.updateOne({ _id: s.wallet._id }, { $set: { status: 'frozen' } });
  expect((await reverse(s)).status).toBe(409);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_reversal' })).toBe(0);
});

it('enforces the vendor own PIN and the existing five-attempt lockout', async () => {
  const s = await setup();
  for (let i = 0; i < 5; i++) expect((await reverse(s, { pin: '000000' })).status).toBe(401);
  expect((await reverse(s)).status).toBe(429);
  expect(await Wallet.findById(s.wallet._id)).toMatchObject({ balance: 6600 });
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_reversal' })).toBe(0);
});

it('another stall cannot reverse the sale and a revoked operator cannot check balances or reverse', async () => {
  const s = await setup(), other = await setup();
  expect((await reverse(s, {}, other.token)).status).toBe(404);
  await MerchantOperator.updateOne({ _id: s.operator._id }, { $set: { isActive: false } });
  expect((await reverse(s)).status).toBe(401);
  expect((await request(app).get('/api/merchant/balance?bandUid=aabbccdd').set('Authorization', `Bearer ${s.token}`)).status).toBe(401);
});

it('never guesses the funding split for old sales or cancels one leg of a table payment', async () => {
  const s = await setup();
  await MerchantCharge.updateOne({ _id: s.charge._id }, { $unset: { cashFundedAmount: 1 } });
  expect((await reverse(s)).status).toBe(409);
  await MerchantCharge.updateOne({ _id: s.charge._id }, { $set: { cashFundedAmount: 3400, waiterId: new mongoose.Types.ObjectId() } });
  expect((await reverse(s)).status).toBe(409);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_reversal' })).toBe(0);
});

it('a retry of a cancelled charge cannot masquerade as a fresh payment', async () => {
  const s = await setup();
  await reverse(s);
  const res = await request(app).post('/api/merchant/charge').set('Authorization', `Bearer ${s.token}`).send({ bandUid: 'aabbccdd', amount: 3000, quotedTotal: 3400, clientTxnId: 'sale' });
  expect(res.status).toBe(409); expect(res.body.message).toMatch(/reversed/i);
  expect((await Wallet.findById(s.wallet._id))!.balance).toBe(10000);
});
