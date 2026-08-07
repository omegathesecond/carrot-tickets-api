import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletTopup } from '@models/walletTopup.model';
import mongoose from 'mongoose';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

// Fixed walletId so the base() row always targets the SAME wallet — the
// idempotency contract is scoped to {walletId, clientTxnId}, not global.
const WALLET_A = new mongoose.Types.ObjectId();
const base = () => ({
  walletId: WALLET_A, eventId: new mongoose.Types.ObjectId(),
  amount: 500, method: 'cash', status: 'completed', recordedBy: 'op1', clientTxnId: 'ctx-1',
});

it('persists a cash topup and enforces unique clientTxnId PER WALLET', async () => {
  await WalletTopup.create(base());
  // Same wallet + same clientTxnId → duplicate (a genuine retry dedups).
  await expect(WalletTopup.create(base())).rejects.toThrow(/duplicate key|E11000/);
});

it('allows the same clientTxnId on a DIFFERENT wallet (idempotency scoped to owner)', async () => {
  await WalletTopup.create(base());
  // Different wallet, same clientTxnId → NOT a duplicate: no cross-tenant
  // collision (the whole point of FIX 1 — the compound {walletId, clientTxnId}
  // unique index instead of a global unique clientTxnId).
  const other = await WalletTopup.create({ ...base(), walletId: new mongoose.Types.ObjectId() });
  expect(other).toBeDefined();
  expect(await WalletTopup.countDocuments({ clientTxnId: 'ctx-1' })).toBe(2);
});
it('rejects a non-positive or non-integer amount', async () => {
  await expect(WalletTopup.create({ ...base(), clientTxnId: 'ctx-2', amount: 0 })).rejects.toThrow();
  await expect(WalletTopup.create({ ...base(), clientTxnId: 'ctx-3', amount: 1.5 })).rejects.toThrow();
});
