import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { ReconciliationService } from '@services/reconciliation.service';
import { LedgerService } from '@services/ledger.service';
import { Wallet } from '@models/wallet.model';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

const eventId = new mongoose.Types.ObjectId().toString();

/** Credit a wallet the honest way: balanced postings AND the stored balance. */
async function topUp(walletId: string, amount: number) {
  await LedgerService.post({
    eventId, refType: 'topup', refId: `t-${walletId}-${amount}`,
    postings: [
      { account: { type: LedgerAccountType.FLOAT }, delta: amount, tag: FloatTag.KESHLESS },
      { account: { type: LedgerAccountType.WALLET, ref: walletId }, delta: -amount },
    ],
  });
  await Wallet.updateOne({ _id: walletId }, { $inc: { balance: amount } });
}

describe('ReconciliationService.checkWalletBalances', () => {
  beforeAll(connectLedgerTestDb, 60000); // replica set: post() commits in a transaction
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('reports ok on an event with no wallets', async () => {
    expect(await ReconciliationService.checkWalletBalances(eventId)).toEqual({
      ok: true, checked: 0, drifted: [], invariantViolations: [], unknownWalletRefs: [],
    });
  });

  it('reports ok when every stored balance matches the journal', async () => {
    const a = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId() });
    const b = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId() });
    await topUp(String(a._id), 5000);
    await topUp(String(b._id), 2500);

    const r = await ReconciliationService.checkWalletBalances(eventId);
    expect(r.checked).toBe(2);
    expect(r.drifted).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('DETECTS a balance mutated without a matching posting', async () => {
    const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId() });
    await topUp(String(w._id), 5000);
    // The bug this check exists to catch: money added to the stored balance
    // with no ledger posting behind it.
    await Wallet.updateOne({ _id: w._id }, { $inc: { balance: 1000 } });

    const r = await ReconciliationService.checkWalletBalances(eventId);
    expect(r.ok).toBe(false);
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0]).toMatchObject({ stored: 6000, journal: 5000, drift: 1000 });
  });

  it('DETECTS a posting with no matching stored balance', async () => {
    const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId() });
    await LedgerService.post({
      eventId, refType: 'topup', refId: 'ghost',
      postings: [
        { account: { type: LedgerAccountType.FLOAT }, delta: 700, tag: FloatTag.KESHLESS },
        { account: { type: LedgerAccountType.WALLET, ref: String(w._id) }, delta: -700 },
      ],
    });
    // stored balance deliberately not incremented

    const r = await ReconciliationService.checkWalletBalances(eventId);
    expect(r.ok).toBe(false);
    expect(r.drifted[0]).toMatchObject({ stored: 0, journal: 700, drift: -700 });
  });

  it('DETECTS a cashFundedBalance > balance invariant violation ($inc bypasses the hook)', async () => {
    const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId() });
    await topUp(String(w._id), 5000);
    // $inc bypasses validators AND the pre('validate') cross-field hook — the
    // exact path SP3/SP5 will use, so this must be caught here or nowhere.
    await Wallet.updateOne({ _id: w._id }, { $inc: { cashFundedBalance: 6000 } });

    const r = await ReconciliationService.checkWalletBalances(eventId);
    expect(r.ok).toBe(false);
    expect(r.invariantViolations).toEqual([String(w._id)]);
    expect(r.drifted).toEqual([]); // balance still agrees with the journal
  });

  it('scopes the check to one event', async () => {
    const other = new mongoose.Types.ObjectId().toString();
    const w = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId() });
    await topUp(String(w._id), 5000);

    expect(await ReconciliationService.checkWalletBalances(other)).toEqual({
      ok: true, checked: 0, drifted: [], invariantViolations: [], unknownWalletRefs: [],
    });
  });
});
