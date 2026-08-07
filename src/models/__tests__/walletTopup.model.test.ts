import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletTopup } from '@models/walletTopup.model';
import mongoose from 'mongoose';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

const base = () => ({
  walletId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId(),
  amount: 500, method: 'cash', status: 'completed', recordedBy: 'op1', clientTxnId: 'ctx-1',
});

it('persists a cash topup and enforces unique clientTxnId', async () => {
  await WalletTopup.create(base());
  await expect(WalletTopup.create(base())).rejects.toThrow(/duplicate key|E11000/);
});
it('rejects a non-positive or non-integer amount', async () => {
  await expect(WalletTopup.create({ ...base(), clientTxnId: 'ctx-2', amount: 0 })).rejects.toThrow();
  await expect(WalletTopup.create({ ...base(), clientTxnId: 'ctx-3', amount: 1.5 })).rejects.toThrow();
});
