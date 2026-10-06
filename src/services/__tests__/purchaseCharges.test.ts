import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Table } from '@models/table.model';
import { Product } from '@models/product.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { EventService } from '@services/event.service';
import { WalletService } from '@services/wallet.service';
import { MerchantService, WalletDeclinedError } from '@services/merchant.service';
import { TableService } from '@services/table.service';
import { OrganizerCashlessService } from '@services/organizerCashless.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { purchaseChargeAmount, PurchaseTotalChangedError } from '@utils/purchaseCharge.util';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);
let operatorSeq = 800100;
async function seed(balance = 10000) {
  const { eventId, vendorId } = await seedPublishedEvent();
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const wallet = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), bandUid: '04a22b1c', status: 'active' });
  await WalletService.topUpCash({ walletId: String(wallet._id), eventId, amount: balance, recordedBy: 'desk', clientTxnId: 'topup' });
  const merchant = await Merchant.create({ eventId, name: 'Stall', commissionPercent: 10 });
  const operator = await MerchantOperator.create({ eventId, merchantId: merchant._id, fullName: 'Operator', loginCode: String(operatorSeq++), pin: '111111' });
  const params = { eventId, merchantId: String(merchant._id), merchantOperatorId: String(operator._id), operatorName: 'Operator', walletId: String(wallet._id), bandUid: '04a22b1c', amount: 3000, clientTxnId: 'purchase' };
  return { eventId, vendorId, wallet, merchant, operator, params };
}

it.each([{ type: 'fixed' as const, value: 250 }, { type: 'percentage' as const, value: 5 }])('organizers can save $type charges, change them and disable them', async (setting) => {
  const { eventId, vendorId } = await seed();
  expect((await EventService.updateEvent(eventId, vendorId, { purchaseCharge: setting })).purchaseCharge).toMatchObject(setting);
  expect((await EventService.updateEvent(eventId, vendorId, { purchaseCharge: null })).purchaseCharge).toBeNull();
});
it('refuses another organizer and invalid settings', async () => {
  const { eventId, vendorId } = await seed();
  await expect(EventService.updateEvent(eventId, String(new mongoose.Types.ObjectId()), { purchaseCharge: { type: 'fixed', value: 100 } })).rejects.toThrow();
  for (const setting of [{ type: 'fixed' as const, value: 1.5 }, { type: 'percentage' as const, value: 100.01 }, { type: 'percentage' as const, value: 1.234 }]) {
    await expect(EventService.updateEvent(eventId, vendorId, { purchaseCharge: setting })).rejects.toThrow();
  }
});
it.each([{ type: 'fixed' as const, value: 250, fee: 250 }, { type: 'percentage' as const, value: 2.55, fee: 77 }])('adds $type charges without changing stall earnings or platform commission', async ({ fee, ...setting }) => {
  const { eventId, vendorId, params } = await seed();
  await EventService.updateEvent(eventId, vendorId, { purchaseCharge: setting });
  const quote = await MerchantService.quote(params);
  expect(quote).toEqual({ subtotal: 3000, purchaseChargeAmount: fee, total: 3000 + fee });
  const paid = await MerchantService.charge({ ...params, quotedTotal: quote.total });
  expect(paid.wallet.balance).toBe(10000 - 3000 - fee);
  expect(paid.charge).toMatchObject({ amount: 3000 + fee, purchaseChargeAmount: fee, fee: 300, netAmount: 2700 });
  expect(await ReconciliationService.checkInvariant(eventId)).toMatchObject({ ok: true, drift: 0, organizerOwed: fee, feesEarned: 300, merchantsOwed: 2700 });
  expect(await OrganizerCashlessService.summary(eventId)).toMatchObject({ spent: 3000 + fee, purchaseCharges: fee, vendors: [{ gross: 3000, commission: 300, net: 2700 }] });
  // A later setting change must never reprice or debit a committed replay.
  await EventService.updateEvent(eventId, vendorId, { purchaseCharge: { type: 'fixed', value: 999 } });
  const replay = await MerchantService.charge({ ...params, quotedTotal: quote.total });
  expect(String(replay.charge._id)).toBe(String(paid.charge._id));
  expect(replay.wallet.balance).toBe(paid.wallet.balance);
});
it('refuses a stale quote and insufficient funds for purchase plus charge without any writes', async () => {
  const { eventId, vendorId, params } = await seed(3000);
  await EventService.updateEvent(eventId, vendorId, { purchaseCharge: { type: 'fixed', value: 250 } });
  await expect(MerchantService.charge({ ...params, quotedTotal: 3000 })).rejects.toBeInstanceOf(PurchaseTotalChangedError);
  await expect(MerchantService.charge({ ...params, quotedTotal: 3250 })).rejects.toBeInstanceOf(WalletDeclinedError);
  expect((await Wallet.findById(params.walletId))!.balance).toBe(3000);
  expect(await MerchantCharge.countDocuments()).toBe(0);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_charge' })).toBe(0);
});
it('quotes and charges through the till API and requires the reviewed total', async () => {
  const { eventId, vendorId, merchant, operator, params } = await seed();
  await EventService.updateEvent(eventId, vendorId, { purchaseCharge: { type: 'fixed', value: 250 } });
  const token = jwt.sign({ scope: 'merchant', merchantId: String(merchant._id), merchantOperatorId: String(operator._id), operatorName: 'Operator', name: 'Stall', eventId, permissions: [MerchantPermission.CHARGE] }, JWT_SECRET);
  const auth = `Bearer ${token}`;
  const quote = await request(app).post('/api/merchant/quote').set('Authorization', auth).send({ amount: 3000 });
  expect(quote.status).toBe(200);
  expect(quote.body.data.total).toBe(3250);
  const body = { bandUid: params.bandUid, amount: 3000, clientTxnId: 'api' };
  expect((await request(app).post('/api/merchant/charge').set('Authorization', auth).send(body)).status).toBe(400);
  expect((await request(app).post('/api/merchant/charge').set('Authorization', auth).send({ ...body, quotedTotal: 3000 })).status).toBe(409);
  const paid = await request(app).post('/api/merchant/charge').set('Authorization', auth).send({ ...body, quotedTotal: 3250 });
  expect(paid.status).toBe(200);
  expect(paid.body.data).toMatchObject({ amount: 3250, purchaseChargeAmount: 250, newBalance: 6750 });
});
it('charges a fixed amount once on a table spanning two stalls and preserves exact cent allocation', async () => {
  const { eventId, vendorId, merchant, wallet } = await seed();
  await EventService.updateEvent(eventId, vendorId, { purchaseCharge: { type: 'fixed', value: 101 } });
  const second = await Merchant.create({ eventId, name: 'Food', commissionPercent: 0 });
  const products = await Product.create([{ eventId, name: 'Beer', category: 'beer', price: 3000 }, { eventId, name: 'Food', category: 'food', price: 1000 }]);
  const waiter = String(new mongoose.Types.ObjectId());
  const table = await Table.create({ eventId, openedBy: waiter, label: '1', status: 'open', subtotal: 4000, items: products.map((p, i) => ({ productId: p._id, merchantId: i === 0 ? merchant._id : second._id, name: p.name, unitPrice: p.price, qty: 1, addedBy: waiter })) });
  expect((await TableService.quote(String(table._id), eventId)).total).toBe(4101);
  const args = { tableId: String(table._id), eventId, bandUid: '04a22b1c', settledBy: waiter, staffName: 'Waiter', clientTxnId: 'table', quotedTotal: 4101 };
  const paid = await TableService.settle(args);
  expect(paid.walletBalance).toBe(5899);
  expect(paid.charges.reduce((n, c) => n + c.purchaseChargeAmount, 0)).toBe(101);
  expect(paid.charges.reduce((n, c) => n + c.amount, 0)).toBe(4101);
  expect(paid.charges.reduce((n, c) => n + c.netAmount, 0)).toBe(3700);
  expect(await ReconciliationService.checkInvariant(eventId)).toMatchObject({ ok: true, organizerOwed: 101 });
  await TableService.settle(args);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(5899);
});
it('rounds percentage cents deterministically and leaves disabled charges at zero', () => {
  expect(purchaseChargeAmount(100, { type: 'percentage', value: 0.5 })).toBe(1);
  expect(purchaseChargeAmount(3000, null)).toBe(0);
});
