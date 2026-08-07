import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';
import { Wallet } from '@models/wallet.model';
import { WalletTopup } from '@models/walletTopup.model';
import mongoose from 'mongoose';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedActiveWallet() {
  const eventId = new mongoose.Types.ObjectId();
  const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });
  return { eventId: String(eventId), walletId: String(w._id) };
}

it('credits balance + cashFundedBalance and posts a balanced ledger txn', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  const { wallet, topup } = await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'ctx-1' });

  expect(wallet.balance).toBe(500);
  expect(wallet.cashFundedBalance).toBe(500);
  expect(topup.amount).toBe(500);

  const floatBal = await LedgerService.floatBalance(eventId);   // asset, +500
  const owed = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: walletId });
  expect(floatBal).toBe(500);
  expect(-owed).toBe(500); // owed to wallet = 500
});

it('is idempotent on clientTxnId (no double credit)', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });
  await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });
  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(500);
  expect(await WalletTopup.countDocuments({ clientTxnId: 'dup' })).toBe(1);
});

it('throws on a non-active wallet', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await Wallet.updateOne({ _id: walletId }, { $set: { status: 'frozen' } });
  await expect(WalletService.topUpCash({ walletId, eventId, amount: 100, recordedBy: 'op1', clientTxnId: 'x' }))
    .rejects.toThrow(/not active|not found/);
});
