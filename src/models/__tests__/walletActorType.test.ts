// api/src/models/__tests__/walletActorType.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const base = () => ({
  walletId: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId(),
  amount: 5000,
  method: 'cash' as const,
  status: 'completed' as const,
  recordedBy: new mongoose.Types.ObjectId().toString(),
  clientTxnId: `top-${Math.random()}`,
});

describe('WalletTopup.recordedByType', () => {
  it('accepts MerchantOperator as an actor type', async () => {
    const row = await WalletTopup.create({ ...base(), recordedByType: 'MerchantOperator' });
    expect(row.recordedByType).toBe('MerchantOperator');
  });

  it('rejects the retired Merchant actor type', async () => {
    await expect(WalletTopup.create({ ...base(), recordedByType: 'Merchant' as any })).rejects.toThrow(
      /is not a valid enum value/,
    );
  });
});

describe('WalletWithdrawal.recordedByType', () => {
  it('accepts MerchantOperator as an actor type', async () => {
    const row = await WalletWithdrawal.create({ ...base(), recordedByType: 'MerchantOperator' });
    expect(row.recordedByType).toBe('MerchantOperator');
  });

  it('rejects the retired Merchant actor type', async () => {
    await expect(WalletWithdrawal.create({ ...base(), recordedByType: 'Merchant' as any })).rejects.toThrow(
      /is not a valid enum value/,
    );
  });
});
