/**
 * ReconciliationService.checkWalletBalances — cost and coverage.
 *
 * This check runs every 15 minutes in production over every cashless event
 * that ended in the last 7 days (sweepRecentCashlessEvents), so its cost must
 * not scale with the number of wallets: ONE journal aggregation grouped by
 * wallet, joined in memory against the Wallet rows. The same grouped pass also
 * exposes the inverse anomaly — journal postings to a wallet ref that has no
 * Wallet row — which the per-wallet loop could never see.
 *
 * Standalone mongod: postings are written straight to the journal, so no
 * transaction (replica set) is needed. The transactional wallet flows are
 * covered by walletReconciliation.service.test.ts.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ReconciliationService } from '@services/reconciliation.service';
import { Wallet } from '@models/wallet.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

const eventId = new mongoose.Types.ObjectId().toString();

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.restoreAllMocks();
});
afterAll(disconnectTestDb);

async function walletWithBalance(balance: number, cashFundedBalance = 0): Promise<string> {
  const w = await Wallet.create({
    eventId: new mongoose.Types.ObjectId(eventId),
    ticketId: new mongoose.Types.ObjectId(),
    balance,
    cashFundedBalance,
  });
  return String(w._id);
}

/** A balanced posting written straight to the journal: FLOAT +amount / WALLET -amount. */
async function journal(walletRef: string, amount: number) {
  const oid = new mongoose.Types.ObjectId(eventId);
  const txnId = `txn-${walletRef}-${amount}-${Math.random()}`;
  await LedgerEntry.create([
    { eventId: oid, txnId, accountType: LedgerAccountType.FLOAT, accountRef: null, delta: amount, tag: FloatTag.KESHLESS, refType: 't', refId: txnId },
    { eventId: oid, txnId, accountType: LedgerAccountType.WALLET, accountRef: walletRef, delta: -amount, refType: 't', refId: txnId },
  ]);
}

describe('ReconciliationService.checkWalletBalances', () => {
  it('reports drifted, clean, and posting-less wallets from one pass over the journal', async () => {
    const clean = await walletWithBalance(5000);
    await journal(clean, 5000);
    const drifted = await walletWithBalance(5000);
    await journal(drifted, 4000);
    const neverFunded = await walletWithBalance(0);
    const storedButNeverPosted = await walletWithBalance(500);
    const nettedToZero = await walletWithBalance(0);
    await journal(nettedToZero, 100);
    await journal(nettedToZero, -100);

    const r = await ReconciliationService.checkWalletBalances(eventId);

    expect(r.checked).toBe(5);
    expect(r.drifted).toEqual([
      { walletId: drifted, stored: 5000, journal: 4000, drift: 1000 },
      { walletId: storedButNeverPosted, stored: 500, journal: 0, drift: 500 },
    ]);
    expect(r.ok).toBe(false);
    // Silence on the others is the assertion: neverFunded and nettedToZero
    // reconcile at exactly 0, and clean at 5000.
    expect(r.drifted.map((d) => d.walletId)).not.toContain(clean);
    expect(r.drifted.map((d) => d.walletId)).not.toContain(neverFunded);
    expect(r.drifted.map((d) => d.walletId)).not.toContain(nettedToZero);
  });

  it('issues exactly ONE journal aggregation regardless of how many wallets the event has', async () => {
    for (let i = 0; i < 5; i++) await journal(await walletWithBalance(100), 100);
    const aggregate = jest.spyOn(LedgerEntry, 'aggregate');

    const r = await ReconciliationService.checkWalletBalances(eventId);

    expect(r.checked).toBe(5);
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('reports journal postings to a wallet ref that has no Wallet row', async () => {
    const real = await walletWithBalance(1000);
    await journal(real, 1000);
    const ghost = new mongoose.Types.ObjectId().toString();
    await journal(ghost, 700);

    const r = await ReconciliationService.checkWalletBalances(eventId);

    expect(r.unknownWalletRefs).toEqual([ghost]);
    expect(r.drifted).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('still flags cashFundedBalance > balance, and reports an empty unknownWalletRefs on a clean event', async () => {
    const w = await walletWithBalance(100);
    await journal(w, 100);
    // The pre('validate') hook refuses this on create(); an update operator
    // bypasses it, which is exactly the hole this check is the backstop for.
    await Wallet.updateOne({ _id: w }, { $set: { cashFundedBalance: 300 } });

    const r = await ReconciliationService.checkWalletBalances(eventId);

    expect(r).toEqual({
      ok: false, checked: 1, drifted: [], invariantViolations: [w], unknownWalletRefs: [],
    });
  });

  it('scopes the journal pass to the event: another event\'s wallet postings are neither drift nor unknown refs', async () => {
    const other = new mongoose.Types.ObjectId();
    await LedgerEntry.create([
      { eventId: other, txnId: 'o1', accountType: LedgerAccountType.FLOAT, accountRef: null, delta: 900, tag: FloatTag.KESHLESS, refType: 't', refId: 'o1' },
      { eventId: other, txnId: 'o1', accountType: LedgerAccountType.WALLET, accountRef: new mongoose.Types.ObjectId().toString(), delta: -900, refType: 't', refId: 'o1' },
    ]);

    expect(await ReconciliationService.checkWalletBalances(eventId)).toEqual({
      ok: true, checked: 0, drifted: [], invariantViolations: [], unknownWalletRefs: [],
    });
  });
});
