import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { MerchantCharge } from '@models/merchantCharge.model';

beforeAll(connectTestDb);
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

it('requires the operator who rang it up', async () => {
  await expect(new MerchantCharge(base()).save()).rejects.toThrow(/merchantOperatorId/);
});

it('stores the operator and the name snapshot together', async () => {
  const merchantOperatorId = new mongoose.Types.ObjectId();
  const charge = await new MerchantCharge({ ...base(), merchantOperatorId }).save();
  expect(charge.merchantOperatorId.toString()).toBe(merchantOperatorId.toString());
  expect(charge.staffName).toBe('Thabo Dlamini');
});
