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
import { CASHIER_PERMISSIONS } from '@interfaces/cashier.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const TAG = '04a22b1c';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 800;

async function seedDesk() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const cashier = await Cashier.create({
    fullName: 'Nomsa', loginCode: `4KZ${__loginCodeSeq++}`, pin: '222222',
    scope: 'organizer', vendorId, eventId: event._id,
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
  return { eventId: String(event._id), wallet, token };
}

it('POST /topup: 409s a reused clientTxnId with a different amount; same amount replays', async () => {
  const { eventId, wallet, token } = await seedDesk();
  const post = (amount: number) => request(app).post('/api/cashier/topup')
    .set('Authorization', `Bearer ${token}`).send({ bandUid: TAG, eventId, amount, clientTxnId: 'tu-1' });

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
  await WalletService.topUpCash({ walletId: String(wallet._id), eventId, amount: 1000, recordedBy: 'seed', clientTxnId: 'seed' });
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
