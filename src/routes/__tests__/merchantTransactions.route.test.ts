import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { MerchantPermission } from '@interfaces/merchant.interface';

// A plain (non-replica-set) DB is fine here — GET /api/merchant/transactions
// is a pure read (MerchantService.listTransactions), no ledger transaction
// involved. Charges are seeded directly via MerchantCharge.create rather than
// MerchantService.charge, since that method opens a session transaction that
// requires a replica set.
beforeAll(connectTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

type SeededMerchant = { merchantId: string; eventId: string; merchantOperatorId: string };

let __loginCodeSeq = 300;

// authenticateMerchant re-reads the PERSON and the STALL on every request and
// refuses a missing or deactivated one, so the token has to name rows that
// really exist — a fresh ObjectId in the token is a 401, not a fixture.
async function seedMerchant(): Promise<SeededMerchant> {
  const eventId = new mongoose.Types.ObjectId();
  const merchant = await Merchant.create({ name: 'Fixture Merchant', eventId, commissionPercent: 10 });
  const operator = await MerchantOperator.create({
    fullName: 'Thabo Dlamini', merchantId: merchant._id, eventId, loginCode: `4KT${__loginCodeSeq++}`, pin: '111111',
  });
  return { merchantId: String(merchant._id), eventId: String(eventId), merchantOperatorId: String(operator._id) };
}

async function seedCharge(opts: {
  merchantId: string;
  eventId: string;
  amount: number;
  fee: number;
  clientTxnId: string;
  bandUid?: string;
}) {
  const { merchantId, eventId, amount, fee, clientTxnId, bandUid = '04a22b1c3d4e5f' } = opts;
  return MerchantCharge.create({
    merchantId, merchantOperatorId: new mongoose.Types.ObjectId(), eventId, walletId: new mongoose.Types.ObjectId(),
    bandUid, amount, fee, netAmount: amount - fee, clientTxnId, status: 'completed', staffName: 'Fixture Operator',
  });
}

// A merchant token names the STALL and the PERSON on its till; without the
// person authenticateMerchant rejects it.
const token = ({ merchantId, eventId, merchantOperatorId }: SeededMerchant, perms = [MerchantPermission.CHARGE]) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId,
    operatorName: 'Thabo Dlamini', eventId, name: 'Fixture Merchant', permissions: perms,
  }, JWT_SECRET);

it('returns only the requesting merchant\'s charges — isolation across merchants', async () => {
  const a = await seedMerchant();
  const b = await seedMerchant();

  await seedCharge({ merchantId: a.merchantId, eventId: a.eventId, amount: 300, fee: 30, clientTxnId: 'a-1' });
  await seedCharge({ merchantId: a.merchantId, eventId: a.eventId, amount: 500, fee: 50, clientTxnId: 'a-2' });
  await seedCharge({ merchantId: b.merchantId, eventId: b.eventId, amount: 999, fee: 99, clientTxnId: 'b-1' });

  const res = await request(app).get('/api/merchant/transactions')
    .set('Authorization', `Bearer ${token(a)}`);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data.transactions).toHaveLength(2);
  // Every returned charge belongs to merchant A's amounts only (300, 500) — never B's 999.
  const amounts = res.body.data.transactions.map((t: any) => t.amount).sort((x: number, y: number) => x - y);
  expect(amounts).toEqual([300, 500]);
  expect(res.body.data.summary).toEqual({ totalCharged: 800, totalNet: 720, totalFee: 80, count: 2 });
});

it('summary totals reflect ALL charges even when limit truncates the transactions list', async () => {
  const seeded = await seedMerchant();
  const { merchantId, eventId } = seeded;
  await seedCharge({ merchantId, eventId, amount: 100, fee: 10, clientTxnId: 't-1' });
  await seedCharge({ merchantId, eventId, amount: 200, fee: 20, clientTxnId: 't-2' });
  await seedCharge({ merchantId, eventId, amount: 300, fee: 30, clientTxnId: 't-3' });

  const res = await request(app).get('/api/merchant/transactions?limit=1')
    .set('Authorization', `Bearer ${token(seeded)}`);

  expect(res.status).toBe(200);
  expect(res.body.data.transactions).toHaveLength(1);
  // Summary still covers all 3 charges, not just the truncated page.
  expect(res.body.data.summary).toEqual({ totalCharged: 600, totalNet: 540, totalFee: 60, count: 3 });
});

it('maps each transaction to the documented shape', async () => {
  const seeded = await seedMerchant();
  const { merchantId, eventId } = seeded;
  await seedCharge({ merchantId, eventId, amount: 300, fee: 30, clientTxnId: 'shape-1', bandUid: '04a22b1c3d4e5f' });

  const res = await request(app).get('/api/merchant/transactions')
    .set('Authorization', `Bearer ${token(seeded)}`);

  expect(res.status).toBe(200);
  const [t] = res.body.data.transactions;
  expect(t).toMatchObject({
    amount: 300,
    fee: 30,
    netAmount: 270,
    bandUid: '04a22b1c3d4e5f',
    status: 'completed',
  });
  expect(typeof t.id).toBe('string');
  expect(typeof t.createdAt).toBe('string'); // serialized Date
});

it('returns an empty list and a zeroed summary when the merchant has no charges', async () => {
  const seeded = await seedMerchant();
  const { merchantId, eventId } = seeded;

  const res = await request(app).get('/api/merchant/transactions')
    .set('Authorization', `Bearer ${token(seeded)}`);

  expect(res.status).toBe(200);
  expect(res.body.data.transactions).toEqual([]);
  expect(res.body.data.summary).toEqual({ totalCharged: 0, totalNet: 0, totalFee: 0, count: 0 });
});

it('rejects an unauthenticated request with 401', async () => {
  const res = await request(app).get('/api/merchant/transactions');
  expect(res.status).toBe(401);
});

// Pre-Task-3, a hand-forged `permissions: []` was the only way to make an
// authenticated request look like it lacked merchant:charge, so this used to
// 403. authenticateMerchant now derives permissions from the operator row
// (merchant:charge is an unconditional floor — every operator can charge,
// same as MerchantAuthService.login has always minted), so the token's own
// `permissions` claim can no longer take a capability away any more than it
// can grant one it doesn't have (see merchantStockAccess.route.test.ts for
// the grant side). The forged empty array is now inert either way.
it('ignores a forged permissions array — authorization comes from the operator row', async () => {
  const seeded = await seedMerchant();
  const res = await request(app).get('/api/merchant/transactions')
    .set('Authorization', `Bearer ${token(seeded, [])}`);
  expect(res.status).toBe(200);
});
