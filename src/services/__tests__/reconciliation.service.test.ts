import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { LedgerService } from '@services/ledger.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

const eventId = new mongoose.Types.ObjectId().toString();

describe('ReconciliationService', () => {
  beforeAll(connectLedgerTestDb, 60000); // replica set: post() commits in a transaction
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('reports a zero-drift invariant on an empty event', async () => {
    const r = await ReconciliationService.checkInvariant(eventId);
    expect(r).toEqual({ ok: true, float: 0, walletsOwed: 0, merchantsOwed: 0, feesEarned: 0, drift: 0 });
  });

  it('holds the identity after top-up then spend', async () => {
    await LedgerService.post({
      eventId, refType: 'topup', refId: 't1',
      postings: [
        { account: { type: LedgerAccountType.FLOAT }, delta: 5000, tag: FloatTag.KESHLESS },
        { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -5000 },
      ],
    });
    await LedgerService.post({
      eventId, refType: 'charge', refId: 'c1',
      postings: [
        { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: 1000 },
        { account: { type: LedgerAccountType.MERCHANT, ref: 'm1' }, delta: -900 },
        { account: { type: LedgerAccountType.FEES }, delta: -100 },
      ],
    });

    const r = await ReconciliationService.checkInvariant(eventId);
    expect(r.float).toBe(5000);
    expect(r.walletsOwed).toBe(4000);
    expect(r.merchantsOwed).toBe(900);
    expect(r.feesEarned).toBe(100);
    expect(r.drift).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('detects drift introduced by a direct write that bypasses LedgerService', async () => {
    // Simulate a rogue/legacy writer inserting an unbalanced single leg.
    await LedgerEntry.create({
      eventId: new mongoose.Types.ObjectId(eventId),
      txnId: 'rogue-1',
      accountType: LedgerAccountType.FLOAT,
      accountRef: null,
      delta: 9999,
      tag: FloatTag.KESHLESS,
      refType: 'rogue',
      refId: 'r1',
    });

    const r = await ReconciliationService.checkInvariant(eventId);
    expect(r.ok).toBe(false);
    expect(r.drift).toBe(9999);
  });

  it('reports journal integrity as ok when every txn balances', async () => {
    await LedgerService.post({
      eventId, refType: 'topup', refId: 't1',
      postings: [
        { account: { type: LedgerAccountType.FLOAT }, delta: 100, tag: FloatTag.KESHLESS },
        { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -100 },
      ],
    });
    expect(await ReconciliationService.checkJournalIntegrity(eventId)).toEqual({
      ok: true, unbalancedTxnIds: [],
    });
  });

  it('names the offending txnIds when a txn does not balance', async () => {
    await LedgerEntry.create({
      eventId: new mongoose.Types.ObjectId(eventId),
      txnId: 'rogue-2',
      accountType: LedgerAccountType.FLOAT,
      accountRef: null,
      delta: 500,
      refType: 'rogue',
      refId: 'r2',
    });
    const r = await ReconciliationService.checkJournalIntegrity(eventId);
    expect(r.ok).toBe(false);
    expect(r.unbalancedTxnIds).toEqual(['rogue-2']);
  });
});
