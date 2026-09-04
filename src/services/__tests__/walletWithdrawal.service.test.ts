import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService, MAX_TOPUP_CENTS, WalletIdempotencyMismatchError } from '@services/wallet.service';
import { WalletDeclinedError } from '@services/merchant.service';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';
import { Wallet } from '@models/wallet.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import mongoose from 'mongoose';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedFundedWallet(amount = 1000) {
  const eventId = new mongoose.Types.ObjectId();
  const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });
  await WalletService.topUpCash({
    walletId: String(w._id), eventId: String(eventId), amount, recordedBy: 'op1', clientTxnId: 'seed-topup',
  });
  return { eventId: String(eventId), walletId: String(w._id) };
}

it('debits the wallet and posts a balanced ledger txn (WALLET +amt / FLOAT -amt) + a WalletWithdrawal', async () => {
  const { eventId, walletId } = await seedFundedWallet(1000);

  const { wallet, withdrawal } = await WalletService.withdrawCash({
    walletId, eventId, amount: 300, recordedBy: 'cash1', clientTxnId: 'wd-1',
  });

  expect(wallet.balance).toBe(700);
  expect(wallet.cashFundedBalance).toBe(700); // cash drawn down alongside balance
  expect(withdrawal.amount).toBe(300);
  expect(withdrawal.recordedByType).toBe('Cashier');
  expect(withdrawal.status).toBe('completed');

  // wallet is credit-normal: owed to attendee dropped 1000 -> 700.
  const walletOwed = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: walletId });
  expect(-walletOwed).toBe(700);
  // float is debit-normal: cash held dropped 1000 -> 700 (300 paid out).
  const floatHeld = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.FLOAT });
  expect(floatHeld).toBe(700);

  const entries = await LedgerEntry.find({ refType: 'wallet_withdrawal', refId: 'wd-1' }).lean();
  expect(entries).toHaveLength(2);
  expect(entries.reduce((s, e) => s + e.delta, 0)).toBe(0); // balanced

  expect(await WalletWithdrawal.countDocuments({ clientTxnId: 'wd-1' })).toBe(1);
});

it('cash back = full remaining balance: a cash-out may exceed cashFundedBalance (floored at 0)', async () => {
  // Simulate 400 cash-funded + 600 non-cash (e.g. card) by seeding the wallet directly.
  const eventId = new mongoose.Types.ObjectId();
  const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active', balance: 1000, cashFundedBalance: 400 });

  const { wallet } = await WalletService.withdrawCash({
    walletId: String(w._id), eventId: String(eventId), amount: 1000, recordedBy: 'cash1', clientTxnId: 'wd-full',
  });

  expect(wallet.balance).toBe(0);
  expect(wallet.cashFundedBalance).toBe(0); // floored, never negative
});

it('DECLINES with WalletDeclinedError on insufficient balance — wallet unchanged, no ledger, no row', async () => {
  const { eventId, walletId } = await seedFundedWallet(100);

  await expect(
    WalletService.withdrawCash({ walletId, eventId, amount: 500, recordedBy: 'cash1', clientTxnId: 'wd-decline' }),
  ).rejects.toMatchObject({ reason: 'insufficient_balance', currentBalance: 100 });

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(100); // UNCHANGED
  expect(await LedgerEntry.countDocuments({ refType: 'wallet_withdrawal', refId: 'wd-decline' })).toBe(0);
  expect(await WalletWithdrawal.countDocuments({ clientTxnId: 'wd-decline' })).toBe(0);
});

it('DECLINES on a non-active wallet without writing anything', async () => {
  const { eventId, walletId } = await seedFundedWallet(1000);
  await Wallet.updateOne({ _id: walletId }, { $set: { status: 'frozen' } });

  await expect(
    WalletService.withdrawCash({ walletId, eventId, amount: 100, recordedBy: 'cash1', clientTxnId: 'wd-frozen' }),
  ).rejects.toMatchObject({ reason: 'wallet_not_active' });

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(1000);
  expect(await WalletWithdrawal.countDocuments({ clientTxnId: 'wd-frozen' })).toBe(0);
});

it('is idempotent on {walletId, clientTxnId} — no double cash-out', async () => {
  const { eventId, walletId } = await seedFundedWallet(1000);

  await WalletService.withdrawCash({ walletId, eventId, amount: 300, recordedBy: 'cash1', clientTxnId: 'wd-dup' });
  await WalletService.withdrawCash({ walletId, eventId, amount: 300, recordedBy: 'cash1', clientTxnId: 'wd-dup' });

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(700); // debited ONCE, not 400
  expect(await WalletWithdrawal.countDocuments({ clientTxnId: 'wd-dup' })).toBe(1);
});

it('rejects a replay of the same clientTxnId with a DIFFERENT amount (no debit, no new row)', async () => {
  const { eventId, walletId } = await seedFundedWallet(1000);
  await WalletService.withdrawCash({ walletId, eventId, amount: 300, recordedBy: 'cash1', clientTxnId: 'wd-dup' });

  await expect(WalletService.withdrawCash({ walletId, eventId, amount: 400, recordedBy: 'cash1', clientTxnId: 'wd-dup' }))
    .rejects.toBeInstanceOf(WalletIdempotencyMismatchError);
  await expect(WalletService.withdrawCash({ walletId, eventId, amount: 400, recordedBy: 'cash1', clientTxnId: 'wd-dup' }))
    .rejects.toThrow(/clientTxnId already used with a different amount/);

  expect((await Wallet.findById(walletId).lean())!.balance).toBe(700);
  expect(await WalletWithdrawal.countDocuments({ walletId, clientTxnId: 'wd-dup' })).toBe(1);
});

it('still returns the ORIGINAL outcome on a true replay (same amount)', async () => {
  const { eventId, walletId } = await seedFundedWallet(1000);
  const first = await WalletService.withdrawCash({ walletId, eventId, amount: 300, recordedBy: 'cash1', clientTxnId: 'wd-dup' });
  const again = await WalletService.withdrawCash({ walletId, eventId, amount: 300, recordedBy: 'cash1', clientTxnId: 'wd-dup' });

  expect(String(again.withdrawal._id)).toBe(String(first.withdrawal._id));
  expect(again.wallet.balance).toBe(700);
});

it('rejects an amount over the ceiling', async () => {
  const { eventId, walletId } = await seedFundedWallet(1000);
  await expect(
    WalletService.withdrawCash({ walletId, eventId, amount: MAX_TOPUP_CENTS + 1, recordedBy: 'cash1', clientTxnId: 'wd-over' }),
  ).rejects.toThrow(/maximum allowed withdrawal|amount/i);
});
