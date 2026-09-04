import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService, MAX_TOPUP_CENTS, WalletIdempotencyMismatchError } from '@services/wallet.service';
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

// A replay is only a replay if it asks for the SAME thing. Answering a retry
// that carries a DIFFERENT amount with the original outcome tells the desk
// "done" while the attendee was credited something else entirely.
it('rejects a replay of the same clientTxnId with a DIFFERENT amount (no credit, no new row)', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });

  await expect(WalletService.topUpCash({ walletId, eventId, amount: 700, recordedBy: 'op1', clientTxnId: 'dup' }))
    .rejects.toBeInstanceOf(WalletIdempotencyMismatchError);
  await expect(WalletService.topUpCash({ walletId, eventId, amount: 700, recordedBy: 'op1', clientTxnId: 'dup' }))
    .rejects.toThrow(/clientTxnId already used with a different amount/);

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(500);
  expect(await WalletTopup.countDocuments({ walletId, clientTxnId: 'dup' })).toBe(1);
});

it('still returns the ORIGINAL outcome on a true replay (same amount)', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  const first = await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });
  const again = await WalletService.topUpCash({ walletId, eventId, amount: 500, recordedBy: 'op1', clientTxnId: 'dup' });

  expect(String(again.topup._id)).toBe(String(first.topup._id));
  expect(again.wallet.balance).toBe(500);
});

// walletId-keyed callers must not be able to post ledger legs under the wrong
// event: the wallet CAS carries eventId, as withdrawCash and MerchantService do.
it('refuses to credit a wallet under a DIFFERENT eventId than the wallet belongs to', async () => {
  const { walletId } = await seedActiveWallet();
  const wrongEvent = String(new mongoose.Types.ObjectId());

  await expect(WalletService.topUpCash({ walletId, eventId: wrongEvent, amount: 500, recordedBy: 'op1', clientTxnId: 'wrong-ev' }))
    .rejects.toThrow(/not found|not active/);

  expect((await Wallet.findById(walletId).lean())!.balance).toBe(0);
  expect(await WalletTopup.countDocuments({ walletId })).toBe(0);
  expect(await LedgerService.floatBalance(wrongEvent)).toBe(0);
});

it('throws on a non-active wallet', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await Wallet.updateOne({ _id: walletId }, { $set: { status: 'frozen' } });
  await expect(WalletService.topUpCash({ walletId, eventId, amount: 100, recordedBy: 'op1', clientTxnId: 'x' }))
    .rejects.toThrow(/not active|not found/);
});

// FIX 1 (idempotency scoped to owner): the same clientTxnId on TWO DIFFERENT
// wallets must credit EACH its own amount — the old global-unique index made the
// second call return the first wallet's row (leak) and skip the second credit.
it('scopes idempotency to the wallet: same clientTxnId on different wallets each credits its own', async () => {
  const a = await seedActiveWallet();
  const b = await seedActiveWallet();
  const shared = 'shared-ctx';

  const { wallet: wA } = await WalletService.topUpCash({ walletId: a.walletId, eventId: a.eventId, amount: 500, recordedBy: 'op1', clientTxnId: shared });
  const { wallet: wB } = await WalletService.topUpCash({ walletId: b.walletId, eventId: b.eventId, amount: 700, recordedBy: 'op1', clientTxnId: shared });

  expect(wA.balance).toBe(500);
  expect(wB.balance).toBe(700); // wallet B's OWN credit, not wallet A's row replayed

  expect((await Wallet.findById(a.walletId).lean())!.balance).toBe(500);
  expect((await Wallet.findById(b.walletId).lean())!.balance).toBe(700);

  // Two distinct rows for the shared id, one scoped to each wallet.
  expect(await WalletTopup.countDocuments({ clientTxnId: shared })).toBe(2);
  expect(await WalletTopup.countDocuments({ walletId: a.walletId, clientTxnId: shared })).toBe(1);
  expect(await WalletTopup.countDocuments({ walletId: b.walletId, clientTxnId: shared })).toBe(1);
});

// FIX 5 (safety ceiling, defense in depth): an amount above MAX_TOPUP_CENTS is
// rejected inside the service even if a caller bypassed the Joi ceiling.
it('rejects an amount over MAX_TOPUP_CENTS', async () => {
  const { eventId, walletId } = await seedActiveWallet();
  await expect(WalletService.topUpCash({ walletId, eventId, amount: MAX_TOPUP_CENTS + 1, recordedBy: 'op1', clientTxnId: 'over' }))
    .rejects.toThrow(/maximum allowed top-up|amount/i);
});
