// api/src/routes/__tests__/cashierTopupIdempotency.route.test.ts
//
// A POS retry carries the same clientTxnId; a retry that carries a DIFFERENT
// amount is not a retry, it is a second, contradictory instruction. Answering
// it with the original outcome (200, first amount) tells the cashier "done"
// while the wallet holds something else. The desk gets a 409 it can act on.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { Cashier } from '@models/cashier.model';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { WalletService } from '@services/wallet.service';
import { EventStatus } from '@interfaces/event.interface';
import { CashierPermission, CASHIER_PERMISSIONS } from '@interfaces/cashier.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const TAG = '04a22b1c';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 800;

async function seedDesk(grants = ['topup_cash', 'topup_card', 'withdraw_cash']) {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const cashier = await Cashier.create({
    fullName: 'Nomsa', loginCode: `4KZ${__loginCodeSeq++}`, pin: '222222',
    scope: 'organizer', vendorId, eventId: event._id, grants,
  });
  const wallet = await WalletService.ensureWalletForTicket({
    ticketId: String(new mongoose.Types.ObjectId()), eventId: String(event._id),
  });
  await enrolTags(event._id, TAG);
  await WalletService.bindBand(String(wallet._id), TAG, 'desk');
  const token = jwt.sign({
    scope: 'cashier', userType: 'cashier', cashierId: String(cashier._id), role: 'cashier',
    permissions: CASHIER_PERMISSIONS, isSuperAdmin: false, fullName: 'Nomsa',
    vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), wallet, token, cashier };
}

it('POST /topup: 409s a reused clientTxnId with a different amount; same amount replays', async () => {
  const { eventId, wallet, token } = await seedDesk();
  const post = (amount: number) => request(app).post('/api/cashier/topup')
    .set('Authorization', `Bearer ${token}`).send({ method: 'cash', bandUid: TAG, eventId, amount, clientTxnId: 'tu-1' });

  expect((await post(500)).status).toBe(200);

  const mismatch = await post(900);
  expect(mismatch.status).toBe(409);
  expect(mismatch.body.message).toMatch(/clientTxnId already used with a different amount/);

  const replay = await post(500);
  expect(replay.status).toBe(200);
  expect(replay.body.data.newBalance).toBe(500);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(500);
  expect(await WalletTopup.countDocuments({ walletId: wallet._id })).toBe(1);
});

it('POST /withdraw: 409s a reused clientTxnId with a different amount; same amount replays', async () => {
  const { eventId, wallet, token } = await seedDesk();
  await WalletService.topUpAtDesk({ method: 'cash', walletId: String(wallet._id), eventId, amount: 1000, recordedBy: 'seed', clientTxnId: 'seed' });
  const post = (amount: number) => request(app).post('/api/cashier/withdraw')
    .set('Authorization', `Bearer ${token}`).send({ bandUid: TAG, eventId, amount, clientTxnId: 'wd-1' });

  expect((await post(300)).status).toBe(200);

  const mismatch = await post(400);
  expect(mismatch.status).toBe(409);
  expect(mismatch.body.message).toMatch(/clientTxnId already used with a different amount/);

  const replay = await post(300);
  expect(replay.status).toBe(200);
  expect(replay.body.data.newBalance).toBe(700);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(700);
  expect(await WalletWithdrawal.countDocuments({ walletId: wallet._id })).toBe(1);
});

it('requires Cash or Card on every request and records card-machine reloads', async () => {
  const { eventId, wallet, token } = await seedDesk();
  const body = { bandUid: TAG, eventId, amount: 500, clientTxnId: 'card-record' };
  const post = (payload: object) => request(app).post('/api/cashier/topup').set('Authorization', `Bearer ${token}`).send(payload);
  expect((await post(body)).status).toBe(400);
  expect((await post({ ...body, method: 'other' })).status).toBe(400);
  const first = await post({ ...body, method: 'card' });
  expect(first.status).toBe(200);
  expect(first.body.data.method).toBe('card');
  expect((await Wallet.findById(wallet._id))!.cashFundedBalance).toBe(0);
  const replay = await post({ ...body, method: 'card' });
  expect(replay.status).toBe(200);
  const changed = await post({ ...body, method: 'cash' });
  expect(changed.status).toBe(409);
  expect(changed.body.message).toMatch(/different payment method/);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(500);
  // A different reload must supply its own method again.
  expect((await post({ ...body, clientTxnId: 'next' })).status).toBe(400);
});


it('cash-only access refuses card and withdrawals without changing money', async () => {
  const {eventId, wallet, token} = await seedDesk(['topup_cash']);
  const post = (method: string) => request(app).post('/api/cashier/topup').set('Authorization', `Bearer ${token}`)
    .send({method, eventId, bandUid: TAG, amount: 500, clientTxnId: method});
  expect((await post('card')).status).toBe(403);
  expect((await post('cash')).status).toBe(200);
  expect((await request(app).post('/api/cashier/withdraw').set('Authorization', `Bearer ${token}`)
    .send({eventId, bandUid: TAG, amount: 100, clientTxnId: 'denied'})).status).toBe(403);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(500);
  expect(await WalletWithdrawal.countDocuments()).toBe(0);
  expect(await WalletTopup.countDocuments()).toBe(1);
});

it('admin grant additions and revocations take effect for the same existing token', async () => {
  const {eventId, wallet, token, cashier} = await seedDesk(['topup_cash']);
  const post = (method: string, id: string) => request(app).post('/api/cashier/topup').set('Authorization', `Bearer ${token}`)
    .send({method, eventId, bandUid: TAG, amount: 500, clientTxnId: id});
  await Cashier.updateOne({_id:cashier._id}, {$set:{grants:['topup_card']}});
  expect((await post('cash', 'denied')).status).toBe(403);
  expect((await post('card', 'allowed')).status).toBe(200);
  const events = await request(app).get('/api/cashier/events').set('Authorization', `Bearer ${token}`);
  expect(events.body.data.permissions).toContain(CashierPermission.CARD_TOPUP);
  expect(events.body.data.permissions).not.toContain(CashierPermission.CASH_TOPUP);
  await Cashier.updateOne({_id:cashier._id}, {$set:{grants:[]}});
  expect((await post('card', 'revoked')).status).toBe(403);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(500);
});

it('a legacy permissive token cannot grant an unconfigured cashier money access', async()=> {
  const {eventId, wallet, cashier} = await seedDesk([]);
  const token = jwt.sign({scope:'cashier', cashierId:String(cashier._id), permissions:Object.values(CashierPermission)}, JWT_SECRET);
  expect((await request(app).post('/api/cashier/topup').set('Authorization', `Bearer ${token}`)
    .send({method:'cash', eventId, bandUid:TAG, amount:500, clientTxnId:'old'})).status).toBe(403);
  expect((await Wallet.findById(wallet._id))!.balance).toBe(0);
  expect(await WalletTopup.countDocuments()).toBe(0);
});


it('shares the cashier lookup between permission and event checks within each HTTP request', async()=>{
  const {token,cashier} = await seedDesk(['topup_cash']);
  const read = jest.spyOn(Cashier, 'findById');
  try {
    expect((await request(app).get('/api/cashier/events').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    await Cashier.updateOne({_id:cashier._id}, {$set:{grants:['topup_card']}});
    const changed = await request(app).get('/api/cashier/events').set('Authorization', `Bearer ${token}`);
    expect(changed.body.data.permissions).toContain(CashierPermission.CARD_TOPUP);
    expect(changed.body.data.permissions).not.toContain(CashierPermission.CASH_TOPUP);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {read.mockRestore();}
});
