import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { MerchantService, WalletDeclinedError, MAX_CHARGE_CENTS } from '@services/merchant.service';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';
import { Wallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import mongoose from 'mongoose';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 0;

async function seedFundedWallet(amount = 1000) {
  const eventId = new mongoose.Types.ObjectId();
  const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });
  await WalletService.topUpCash({
    walletId: String(w._id), eventId: String(eventId), amount, recordedBy: 'op1', clientTxnId: 'seed-topup',
  });
  return { eventId: String(eventId), walletId: String(w._id), bandUid: '04a22b1c3d4e5f' };
}

async function seedMerchant(eventId: string, commissionPercent = 0) {
  // A stall holds no credentials — the people on its till do (MerchantOperator).
  const m = await Merchant.create({ name: 'Fixture Merchant', eventId, commissionPercent });
  return String(m._id);
}

async function seedOperatorFor(merchantId: string, eventId: string, fullName = 'Thabo Dlamini') {
  const op = new MerchantOperator({
    fullName, merchantId, eventId, loginCode: `4KZ9P${__loginCodeSeq++ % 10}`, pin: '111111',
  });
  await op.save();
  return String(op._id);
}

// Deactivating a person is the ONLY revocation control the dashboard offers
// (PATCH /merchant-operators/:id {isActive:false}), and authenticateMerchant
// is pure JWT verification with no DB read against tokens that live for days.
// If the charge transaction did not re-read the operator, revoking someone
// would leave them debiting attendee wallets for the rest of the week.
it('REFUSES a charge by a DEACTIVATED operator, and writes nothing at all', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);
  await MerchantOperator.updateOne({ _id: merchantOperatorId }, { $set: { isActive: false } });

  await expect(
    MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-revoked',
    }),
  ).rejects.toThrow(/^merchant operator not found or not active$/);

  // Nothing partial: no record of the sale, no debit, no postings. The stall
  // itself is untouched and still active — only the person was revoked.
  expect(await MerchantCharge.countDocuments({ clientTxnId: 'chg-revoked' })).toBe(0);
  expect((await Wallet.findById(walletId))!.balance).toBe(1000);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_charge', refId: 'chg-revoked' })).toBe(0);
});

// The other half of the same guard, mirroring how a vanished MERCHANT is
// treated: a token naming an operator row that is gone fails closed rather
// than charging as an operator nobody can name.
it('REFUSES a charge naming an operator row that no longer exists', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);
  await MerchantOperator.deleteOne({ _id: merchantOperatorId });

  await expect(
    MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-vanished',
    }),
  ).rejects.toThrow(/^merchant operator not found or not active$/);

  expect(await MerchantCharge.countDocuments({ clientTxnId: 'chg-vanished' })).toBe(0);
  expect((await Wallet.findById(walletId))!.balance).toBe(1000);
  expect(await LedgerEntry.countDocuments({ refType: 'merchant_charge', refId: 'chg-vanished' })).toBe(0);
});

it('debits the wallet by amount and posts a balanced ledger txn + a MerchantCharge (no commission)', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  const { wallet, charge } = await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-1',
  });

  expect(wallet.balance).toBe(700);
  expect(charge.amount).toBe(300);
  expect(charge.fee).toBe(0);
  expect(charge.netAmount).toBe(300);
  expect(charge.status).toBe('completed');

  const walletOwed = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: walletId });
  const merchantOwed = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.MERCHANT, ref: merchantId });
  // wallet is credit-normal: owed to attendee dropped from 1000 to 700.
  expect(-walletOwed).toBe(700);
  // merchant is credit-normal: owed to merchant is now 300 (the full net, no fee).
  expect(-merchantOwed).toBe(300);

  const entries = await LedgerEntry.find({ refType: 'merchant_charge', refId: 'chg-1' }).lean();
  expect(entries).toHaveLength(2); // WALLET + MERCHANT only, no FEES leg when fee=0
  const sum = entries.reduce((s, e) => s + e.delta, 0);
  expect(sum).toBe(0);

  expect(await MerchantCharge.countDocuments({ clientTxnId: 'chg-1' })).toBe(1);
});

it('splits the fee correctly when commissionPercent > 0', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 10); // 10%
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  const { charge } = await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-fee',
  });

  expect(charge.amount).toBe(300);
  expect(charge.fee).toBe(30); // floor(300 * 10 / 100)
  expect(charge.netAmount).toBe(270);

  const merchantOwed = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.MERCHANT, ref: merchantId });
  const feesOwed = await LedgerService.accountBalance(eventId, { type: LedgerAccountType.FEES });
  expect(-merchantOwed).toBe(270);
  expect(-feesOwed).toBe(30);

  const entries = await LedgerEntry.find({ refType: 'merchant_charge', refId: 'chg-fee' }).lean();
  expect(entries).toHaveLength(3); // WALLET + MERCHANT + FEES
  const sum = entries.reduce((s, e) => s + e.delta, 0);
  expect(sum).toBe(0);
});

it('floors a fractional fee (Math.floor, not round)', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 3); // 3%
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  const { charge } = await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 99, clientTxnId: 'chg-floor',
  });
  // 99 * 3 / 100 = 2.97 -> floor -> 2
  expect(charge.fee).toBe(2);
  expect(charge.netAmount).toBe(97);
});

it('DECLINES with 402-worthy WalletDeclinedError on insufficient balance — wallet unchanged, no ledger, no charge row', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(100);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  await expect(
    MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId, walletId, bandUid, amount: 500, clientTxnId: 'chg-decline',
    }),
  ).rejects.toMatchObject({ reason: 'insufficient_balance', currentBalance: 100 });

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(100); // UNCHANGED

  expect(await LedgerEntry.countDocuments({ refType: 'merchant_charge', refId: 'chg-decline' })).toBe(0);
  expect(await MerchantCharge.countDocuments({ clientTxnId: 'chg-decline' })).toBe(0);
});

it('DECLINES on a non-active wallet without writing anything', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);
  await Wallet.updateOne({ _id: walletId }, { $set: { status: 'frozen' } });

  await expect(
    MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId, walletId, bandUid, amount: 100, clientTxnId: 'chg-frozen',
    }),
  ).rejects.toMatchObject({ reason: 'wallet_not_active' });

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(1000); // UNCHANGED
  expect(await MerchantCharge.countDocuments({ clientTxnId: 'chg-frozen' })).toBe(0);
});

it('is idempotent on clientTxnId scoped to the merchant (no double debit)', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'dup',
  });
  await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'dup',
  });

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(700); // debited ONCE, not 400
  expect(await MerchantCharge.countDocuments({ clientTxnId: 'dup' })).toBe(1);
});

it('rejects a suspended merchant', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);
  await Merchant.updateOne({ _id: merchantId }, { $set: { status: 'suspended' } });

  await expect(
    MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId, walletId, bandUid, amount: 100, clientTxnId: 'chg-suspended',
    }),
  ).rejects.toThrow(/not active|not found/);

  const w = await Wallet.findById(walletId).lean();
  expect(w!.balance).toBe(1000);
});

it('rejects an amount over MAX_CHARGE_CENTS', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);
  await expect(
    MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId, walletId, bandUid, amount: MAX_CHARGE_CENTS + 1, clientTxnId: 'over',
    }),
  ).rejects.toThrow(/maximum allowed charge|amount/i);
});

it('WalletDeclinedError carries a machine-readable reason', async () => {
  // A freshly-minted wallet defaults to balance 0 — seedFundedWallet(0) would
  // itself reject (topUpCash requires amount > 0), so create the wallet bare.
  const eventId = new mongoose.Types.ObjectId();
  const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });
  const walletId = String(w._id);
  const bandUid = '04a22b1c3d4e5f';
  const merchantId = await seedMerchant(String(eventId), 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, String(eventId));
  try {
    await MerchantService.charge({
      merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
      eventId: String(eventId), walletId, bandUid, amount: 100, clientTxnId: 'chg-zero',
    });
    throw new Error('expected a decline');
  } catch (e) {
    expect(e).toBeInstanceOf(WalletDeclinedError);
    expect((e as WalletDeclinedError).reason).toBe('insufficient_balance');
  }
});

it('ignores a staffName supplied by the client', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 0);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-forge-1',
    // A stale POS may still send this; it must not reach the record.
    staffName: 'Somebody Else',
  } as any);

  const charge = await MerchantCharge.findOne({ clientTxnId: 'chg-forge-1' });
  expect(charge!.staffName).toBe('Thabo Dlamini');
  expect(charge!.merchantOperatorId.toString()).toBe(merchantOperatorId);
});

it('credits the STALL in the ledger, never the operator', async () => {
  const { eventId, walletId, bandUid } = await seedFundedWallet(1000);
  const merchantId = await seedMerchant(eventId, 10);
  const merchantOperatorId = await seedOperatorFor(merchantId, eventId);

  await MerchantService.charge({
    merchantId, merchantOperatorId, operatorName: 'Thabo Dlamini',
    eventId, walletId, bandUid, amount: 300, clientTxnId: 'chg-ledger-1',
  });

  // LedgerEntry stores the account as flat accountType/accountRef fields
  // (not a nested `account` object) — query and assert on those directly so
  // this genuinely proves the posting's ref, not a typo'd no-op filter.
  const entries = await LedgerEntry.find({ accountType: LedgerAccountType.MERCHANT });
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(String(entry.accountRef)).toBe(merchantId);
    expect(String(entry.accountRef)).not.toBe(merchantOperatorId);
  }
});
