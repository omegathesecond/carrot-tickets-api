// api/src/routes/__tests__/merchantRevocation.route.test.ts
//
// authenticateMerchant used to be pure JWT verification. Only MerchantService
// .charge re-read the operator and the stall, so PATCH /merchant-operators/:id
// {isActive:false} and suspending a stall bit on /charge alone — the same
// token kept reading the stall's takings, its stock board and posting stock
// counts for the rest of its 7-day life. The liveness check now sits in the
// middleware so EVERY merchant route is covered.
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantAuthService } from '@services/merchantAuth.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 700;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

/** A real stall + person + a token minted by the real login, as the POS would hold. */
async function seedLoggedInOperator() {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({ name: 'Main Bar', eventId, commissionPercent: 10 });
  const loginCode = nextLoginCode();
  const operator = await new MerchantOperator({
    fullName: 'Thabo Dlamini', merchantId: merchant._id, eventId, loginCode, pin: '123456',
  }).save();
  const { accessToken } = await MerchantAuthService.login(loginCode, '123456');
  return { merchant, operator, accessToken };
}

const stock = (token: string) =>
  request(app).get('/api/merchant/stock').set('Authorization', `Bearer ${token}`);

it('a live operator on a live stall reads stock (the control)', async () => {
  const { accessToken } = await seedLoggedInOperator();
  const res = await stock(accessToken);
  expect(res.status).toBe(200);
});

it('deactivating the operator after login → 401 on GET /api/merchant/stock', async () => {
  const { operator, accessToken } = await seedLoggedInOperator();
  expect((await stock(accessToken)).status).toBe(200);

  await MerchantOperator.updateOne({ _id: operator._id }, { $set: { isActive: false } });

  const res = await stock(accessToken);
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('Operator deactivated');
});

it('suspending the stall after login → 401 on every merchant route', async () => {
  const { merchant, accessToken } = await seedLoggedInOperator();
  expect((await stock(accessToken)).status).toBe(200);

  await Merchant.updateOne({ _id: merchant._id }, { $set: { status: 'suspended' } });

  const res = await stock(accessToken);
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('Merchant suspended');
});

it('the check covers transactions and stock counts too, not just /charge', async () => {
  const { operator, accessToken } = await seedLoggedInOperator();
  await MerchantOperator.updateOne({ _id: operator._id }, { $set: { isActive: false } });

  const transactions = await request(app).get('/api/merchant/transactions')
    .set('Authorization', `Bearer ${accessToken}`);
  expect(transactions.status).toBe(401);

  const count = await request(app).post('/api/merchant/stock/count')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ productId: '64c000000000000000000f01', countedOnHand: 1, phase: 'open' });
  expect(count.status).toBe(401);
});

// A token naming a row that no longer exists is not "unknown, let it
// through": a deleted person must lose access the same way a revoked one does.
it('a token whose operator row was deleted → 401', async () => {
  const { operator, accessToken } = await seedLoggedInOperator();
  await MerchantOperator.deleteOne({ _id: operator._id });

  const res = await stock(accessToken);
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('Operator deactivated');
});
