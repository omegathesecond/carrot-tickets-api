import { Buyer } from '@models/buyer.model';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomBytes, randomUUID } from 'crypto';
import { publicTagWithdrawalRoutes, adminTagWithdrawalRoutes } from '../tagWithdrawal.route';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signAdminSessionToken, seedVendorSessionToken, signBuyerSessionToken } from '../../__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { EventTag } from '@models/eventTag.model';
import { Wallet } from '@models/wallet.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { TagWithdrawalRequest } from '@models/tagWithdrawalRequest.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { WalletService } from '@services/wallet.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { EventStatus } from '@interfaces/event.interface';
import { SecurityRateLimitService } from '@services/securityRateLimit.service';

const app = express();
app.use(express.json());
app.use('/public', publicTagWithdrawalRoutes);
app.use('/admin', adminTagWithdrawalRoutes);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ message: err.message }));
let admin: string;
let customer: string;
let event: any;
let wallet: any;
let input: any;
const bank = { country: 'South Africa', bank: 'Test Bank', accountHolder: 'Attendee Name', accountType: 'Savings', branchCode: '123456', accountNumber: '012345678901' };
const auth = (token = admin) => ({ Authorization: `Bearer ${token}` });
const post = (body = input) => request(app).post('/public').set(auth(customer)).send(body);
const decision = (id: string, body: any, token = admin) => request(app).post(`/admin/${id}/status`).set(auth(token)).send(body);

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  process.env['OPERATOR_PIN_ENCRYPTION_KEY'] = Buffer.alloc(32, 9).toString('base64');
  admin = await signAdminSessionToken();
  await Buyer.create({ phone: '+26878422613', name: 'Attendee', password: 'LocalFixtureOnly123!'  });
  customer = await signBuyerSessionToken('+26878422613');
  const past = new Date(Date.now() - 864e5);
  event = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Withdrawal test event', venue: 'Test',
    eventDate: past, startTime: past, endTime: past, cashless: true, status: EventStatus.PUBLISHED, currency: 'SZL', ticketTypes: [] });
  await EventTag.create({ eventId: event._id, bandUid: '0ae98d36' });
  wallet = await Wallet.create({ eventId: event._id, bandUid: '0ae98d36', currency: 'ZAR' });
  await WalletService.topUpAtDesk({ walletId: String(wallet._id), eventId: String(event._id), amount: 12345,
    method: 'cash', recordedBy: 'test-fixture', clientTxnId: randomUUID() });
  input = { bandUid: '0A:E9:8D:36', eventId: String(event._id), expectedAmount: 12345, country: 'ZA', method: 'bank_transfer',
    fullName: 'Attendee Name', contactPhone: '+26878422613', email: 'attendee@example.com', bank,
    clientTxnId: randomUUID(), trackingToken: randomBytes(32).toString('hex') };
});

it('allows signed-in normalized lookup scoped to the selected event and uses the ledger wallet currency', async () => {
  const res = await request(app).post('/public/lookup').set(auth(customer)).send({ bandUid: '0A:E9:8D:36', eventId: String(event._id) });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ eligible: true, balance: 12345, currency: 'ZAR' });
  expect(res.body.data).not.toHaveProperty('buyerId');
});

it('accepts a signed-in request without ownership checks, reserving funds without recording them paid', async () => {
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ status: 'pending', amount: 12345, method: 'bank_transfer' });
  const after = await Wallet.findById(wallet._id);
  expect(after).toMatchObject({ status: 'frozen', balance: 12345, cashFundedBalance: 12345 });
  expect(await WalletWithdrawal.countDocuments()).toBe(0);
  expect((await ReconciliationService.checkWalletBalances(String(event._id))).ok).toBe(true);
  const raw = await TagWithdrawalRequest.collection.findOne({ _id: new mongoose.Types.ObjectId(res.body.data.id) });
  expect(JSON.stringify(raw)).not.toContain(bank.accountNumber);
  expect(JSON.stringify(raw)).not.toContain('+26878422613');
  expect(res.body.data).not.toHaveProperty('detailsEncrypted');
});

it('refuses requests before event end and with an empty or changed balance', async () => {
  await Event.updateOne({ _id: event._id }, { $set: { endTime: new Date(Date.now() + 864e5) } });
  expect((await post()).status).toBe(409);
  await Event.updateOne({ _id: event._id }, { $set: { endTime: new Date(Date.now() - 1000) } });
  expect((await post({ ...input, expectedAmount: 0 })).status).toBe(400);
  expect((await post({ ...input, expectedAmount: 12344 })).status).toBe(409);
  expect((await Wallet.findById(wallet._id))!.status).toBe('active');
});

it('checks tag registration and prevents selecting another event', async () => {
  expect((await post({ ...input, eventId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
  await EventTag.updateOne({ eventId: event._id }, { $set: { status: 'retired' } });
  expect((await post()).status).toBe(404);
});

it('deduplicates simultaneous submissions and refuses a second pending request', async () => {
  const rows = await Promise.all([post(), post()]);
  expect(rows.map(r => r.status)).toEqual([200, 200]);
  expect(rows[0]!.body.data.id).toBe(rows[1]!.body.data.id);
  expect(await TagWithdrawalRequest.countDocuments()).toBe(1);
  expect((await post({ ...input, clientTxnId: randomUUID() })).status).toBe(409);
  expect((await post({ ...input, fullName: 'Different Name' })).status).toBe(409);
});

it('requires the private token for tracking and never exposes destination details', async () => {
  const { body } = await post();
  const path = `/public/${body.data.id}/track`;
  expect((await request(app).post(path).set(auth(customer)).send({ token: randomBytes(32).toString('hex'), eventId: String(event._id) })).status).toBe(404);
  const tracked = await request(app).post(path).set(auth(customer)).send({ token: input.trackingToken, eventId: String(event._id) });
  expect(tracked.status).toBe(200);
  expect(tracked.body.data.status).toBe('pending');
  expect(JSON.stringify(tracked.body)).not.toContain(bank.accountNumber);
  expect(tracked.headers['cache-control']).toBe('no-store');
});

it('restricts dashboard details and decisions to administrators', async () => {
  const { body } = await post();
  expect((await request(app).get('/admin')).status).toBe(401);
  const normal = await seedVendorSessionToken(String(new mongoose.Types.ObjectId()));
  expect((await request(app).get(`/admin/${body.data.id}`).set(auth(normal))).status).toBe(403);
  const details = await request(app).get(`/admin/${body.data.id}`).set(auth());
  expect(details.status).toBe(200);
  expect(details.body.data.details.bank.accountNumber).toBe(bank.accountNumber);
  expect(details.body.data).not.toHaveProperty('detailsEncrypted');
  const list = await request(app).get('/admin?status=pending').set(auth());
  expect(list.body.data.total).toBe(1);
  expect(JSON.stringify(list.body)).not.toContain(bank.accountNumber);
});

it('blocks cash-outs and spending while funds are reserved', async () => {
  await post();
  await expect(WalletService.withdrawCash({ walletId: String(wallet._id), eventId: String(event._id), amount: 100,
    recordedBy: 'test', method: 'office_cash', clientTxnId: randomUUID() })).rejects.toThrow(/not active/);
  await expect(WalletService.topUpAtDesk({ walletId: String(wallet._id), eventId: String(event._id), amount: 100,
    method: 'cash', recordedBy: 'test', clientTxnId: randomUUID() })).rejects.toThrow(/not active/);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(12345);
});

it('claims a payout, records payment once and updates the attendee tracking status', async () => {
  const { body } = await post(); const id = body.data.id;
  expect((await decision(id, { status: 'paid', paymentCompleted: true, paymentReference: 'BANK-123' })).status).toBe(409);
  expect((await decision(id, { status: 'processing' })).status).toBe(200);
  expect((await decision(id, { status: 'paid' })).status).toBe(400);
  const otherAdmin = await signAdminSessionToken();
  expect((await decision(id, { status: 'paid', paymentCompleted: true, paymentReference: 'BANK-123' }, otherAdmin)).status).toBe(409);
  const payload = { status: 'paid', paymentCompleted: true, paymentReference: 'BANK-123' };
  const paid = await decision(id, payload);
  expect(paid.status).toBe(200); expect(paid.body.data.status).toBe('paid');
  expect((await decision(id, payload)).status).toBe(200);
  expect((await decision(id, { ...payload, paymentReference: 'OTHER' })).status).toBe(409);
  expect((await Wallet.findById(wallet._id))).toMatchObject({ balance: 0, cashFundedBalance: 0, status: 'closed' });
  expect(await WalletWithdrawal.countDocuments({ walletId: wallet._id, method: 'bank_transfer' })).toBe(1);
  const legs = await LedgerEntry.find({ refType: 'wallet_withdrawal', refId: `tag-request:${id}` }).lean();
  expect(legs).toHaveLength(2); expect(legs.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
  expect((await ReconciliationService.checkWalletBalances(String(event._id))).ok).toBe(true);
  const tracked = await request(app).post(`/public/${id}/track`).set(auth(customer)).send({ token: input.trackingToken, eventId: String(event._id) });
  expect(tracked.body.data).toMatchObject({ status: 'paid', paymentReference: 'BANK-123' });
});

it('releases the balance on rejection and permits corrected details on a new request', async () => {
  const { body } = await post();
  expect((await decision(body.data.id, { status: 'rejected', rejectionReason: 'Account details could not be used' })).status).toBe(200);
  expect((await Wallet.findById(wallet._id))).toMatchObject({ status: 'active', balance: 12345 });
  expect(await WalletWithdrawal.countDocuments()).toBe(0);
  expect((await post({ ...input, clientTxnId: randomUUID(), trackingToken: randomBytes(32).toString('hex') })).status).toBe(200);
});

it('supports Eswatini mobile money and bank accounts, but refuses South Africa mobile money', async () => {
  const { bank: _bank, ...base } = input;
  const momo = { ...base, country: 'SZ', method: 'mobile_money', mobileNumber: '+26878422613', provider: 'MTN MoMo' };
  expect((await post({ ...momo, country: 'ZA' })).status).toBe(400);
  expect((await post({ ...momo, mobileNumber: '+27712345678' })).status).toBe(400);
  const row = await post(momo); expect(row.status).toBe(200);
  await decision(row.body.data.id, { status: 'rejected', rejectionReason: 'Fixture restart' });
  const szBank = await post({ ...input, country: 'SZ', bank: { ...bank, country: 'Eswatini' }, clientTxnId: randomUUID() });
  expect(szBank.status).toBe(200);
});

it('fails loudly if encryption or abuse-control storage fails, without reserving funds', async () => {
  delete process.env['OPERATOR_PIN_ENCRYPTION_KEY'];
  expect((await post()).status).toBe(500);
  expect((await Wallet.findById(wallet._id))!.status).toBe('active');
  const spy = jest.spyOn(SecurityRateLimitService, 'consume').mockRejectedValueOnce(new Error('Quota store unavailable'));
  expect((await request(app).post('/public/lookup').set(auth(customer)).send({ bandUid: '0ae98d36', eventId: String(event._id) })).status).toBe(500);
  spy.mockRestore();
});

it('requires login for lookup, submission and tracking, and prevents cross-event lookups', async () => {
  expect((await request(app).post('/public/lookup').send({ bandUid: '0ae98d36', eventId: String(event._id) })).status).toBe(401);
  expect((await request(app).post('/public').send(input)).status).toBe(401);
  expect((await request(app).post('/public/000000000000000000000000/track').send({ token: input.trackingToken, eventId: String(event._id) })).status).toBe(401);
  expect((await request(app).post('/public/lookup').set(auth(customer)).send({ bandUid: '0ae98d36', eventId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
});
