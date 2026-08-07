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
import { Wallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 800001;

async function seedMerchantAndFundedBand(opts: { cashless?: boolean; balance?: number; commissionPercent?: number } = {}) {
  const cashless = opts.cashless ?? true;
  const balance = opts.balance ?? 1000;
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });

  const t = await Ticket.create({ eventId, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  const bandUid = '04a22b1c3d4e5f';
  await WalletService.bindBand(String(w._id), bandUid, 'op1');
  if (balance > 0) {
    await WalletService.topUpCash({ walletId: String(w._id), eventId: String(eventId), amount: balance, recordedBy: 'op1', clientTxnId: 'seed-topup' });
  }

  const merchant = await Merchant.create({
    name: 'Fixture Merchant', eventId, commissionPercent: opts.commissionPercent ?? 0,
    loginCode: String(__loginCodeSeq++), pin: '111111',
  });

  return { eventId: String(eventId), bandUid, walletId: String(w._id), merchantId: String(merchant._id) };
}

const token = (merchantId: string, eventId: string, perms = [MerchantPermission.CHARGE], over = {}) =>
  jwt.sign({ scope: 'merchant', merchantId, eventId, name: 'Fixture Merchant', permissions: perms, ...over }, JWT_SECRET);

it('charges a wallet by band uid and credits the merchant', async () => {
  const { eventId, bandUid, merchantId } = await seedMerchantAndFundedBand({ balance: 1000 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, amount: 300, clientTxnId: 'c1' });

  expect(res.status).toBe(200);
  expect(res.body.data.ok).toBe(true);
  expect(res.body.data.newBalance).toBe(700);
  expect(res.body.data.amount).toBe(300);
  expect(res.body.data.fee).toBe(0);
  expect(res.body.data.merchantNet).toBe(300);
});

it('splits the fee when the merchant has a commissionPercent', async () => {
  const { eventId, bandUid, merchantId } = await seedMerchantAndFundedBand({ balance: 1000, commissionPercent: 10 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, amount: 300, clientTxnId: 'c-fee' });

  expect(res.status).toBe(200);
  expect(res.body.data.fee).toBe(30);
  expect(res.body.data.merchantNet).toBe(270);
});

it('declines with 402 on insufficient balance, leaving the wallet unchanged', async () => {
  const { eventId, bandUid, merchantId, walletId } = await seedMerchantAndFundedBand({ balance: 100 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, amount: 500, clientTxnId: 'c-decline' });

  expect(res.status).toBe(402);
  expect(res.body.ok).toBe(false);
  expect(res.body.reason).toBe('insufficient_balance');
  expect(res.body.currentBalance).toBe(100);

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(100); // UNCHANGED
});

it('rejects a non-cashless event with 400', async () => {
  const { eventId, bandUid, merchantId } = await seedMerchantAndFundedBand({ cashless: false, balance: 1000 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid, amount: 300, clientTxnId: 'c-noncashless' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('rejects a token missing merchant:charge with 403', async () => {
  const { eventId, bandUid, merchantId } = await seedMerchantAndFundedBand({ balance: 1000 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId, [])}`)
    .send({ bandUid, amount: 300, clientTxnId: 'c-forbidden' });

  expect(res.status).toBe(403);
});

it('rejects an unauthenticated request with 401', async () => {
  const res = await request(app).post('/api/merchant/charge').send({ bandUid: '04a22b1c3d4e5f', amount: 300, clientTxnId: 'c-noauth' });
  expect(res.status).toBe(401);
});

it('404s an unknown band uid', async () => {
  const { eventId, merchantId } = await seedMerchantAndFundedBand({ balance: 1000 });
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${token(merchantId, eventId)}`)
    .send({ bandUid: 'aaaaaaaaaaaaaa', amount: 300, clientTxnId: 'c-unknownband' });

  expect(res.status).toBe(404);
});

it('is idempotent on clientTxnId at the HTTP layer', async () => {
  const { eventId, bandUid, merchantId } = await seedMerchantAndFundedBand({ balance: 1000 });
  const body = { bandUid, amount: 300, clientTxnId: 'dup-http' };
  const first = await request(app).post('/api/merchant/charge').set('Authorization', `Bearer ${token(merchantId, eventId)}`).send(body);
  const second = await request(app).post('/api/merchant/charge').set('Authorization', `Bearer ${token(merchantId, eventId)}`).send(body);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body.data.newBalance).toBe(700); // debited ONCE, not twice
});

it('rejects a bad-scope token (e.g. a reseller token) with 401', async () => {
  const { eventId, bandUid } = await seedMerchantAndFundedBand({ balance: 1000 });
  const notMerchantToken = jwt.sign({ scope: 'reseller', resellerId: 'r1', hubId: null, operatorId: 'op1', role: 'reseller_operator', permissions: [] }, JWT_SECRET);
  const res = await request(app).post('/api/merchant/charge')
    .set('Authorization', `Bearer ${notMerchantToken}`)
    .send({ bandUid, amount: 300, clientTxnId: 'c-badscope', eventId });

  expect(res.status).toBe(401);
});
