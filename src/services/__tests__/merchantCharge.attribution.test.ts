import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { MerchantCharge } from '@models/merchantCharge.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const base = () => ({
  merchantId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
  walletId: new mongoose.Types.ObjectId(),
  bandUid: '04A2B3C4',
  amount: 5000, fee: 500, netAmount: 4500,
  clientTxnId: `chg-${Math.random()}`,
  status: 'completed' as const,
  staffName: 'Thabo Dlamini',
});

// Was "requires the operator who rang it up" — merchantOperatorId became optional
// so a table settled by a waiter (no till operator) can still be recorded; see
// src/models/__tests__/merchantChargeWaiter.test.ts for that case. staffName (the
// field this suite's base() already sets) is now the one attribution every charge
// keeps, till or table.
it('allows no till operator when nothing else identifies one (e.g. a table charge)', async () => {
  const charge = await new MerchantCharge(base()).save();
  expect(charge.merchantOperatorId).toBeUndefined();
});

it('stores the operator and the name snapshot together', async () => {
  const merchantOperatorId = new mongoose.Types.ObjectId();
  const charge = await new MerchantCharge({ ...base(), merchantOperatorId }).save();
  expect(String(charge.merchantOperatorId)).toBe(merchantOperatorId.toString());
  expect(charge.staffName).toBe('Thabo Dlamini');
});
