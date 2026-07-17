import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { LedgerService } from '@services/ledger.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

/**
 * Deterministic PRNG (mulberry32) so a failure is reproducible from its seed.
 * Math.random() would make a red build impossible to re-run.
 */
function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ledger invariant (property)', () => {
  beforeAll(connectLedgerTestDb, 60000); // replica set: post() commits in a transaction
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it.each([1, 2, 3])('holds across a random 60-transaction sequence (seed %i)', async (seed) => {
    const eventId = new mongoose.Types.ObjectId().toString();
    const rand = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const cents = (max: number) => 1 + Math.floor(rand() * max);

    const wallets = ['w1', 'w2', 'w3'];
    const merchants = ['m1', 'm2'];
    // Mirror of the ledger, kept independently so we assert against a second source.
    const owed: Record<string, number> = { w1: 0, w2: 0, w3: 0 };
    const earned: Record<string, number> = { m1: 0, m2: 0 };

    for (let i = 0; i < 60; i++) {
      const w = pick(wallets);
      const move = pick(['topup', 'topup', 'spend', 'refund'] as const);

      if (move === 'topup') {
        const amt = cents(10_000);
        await LedgerService.post({
          eventId, refType: 'topup', refId: `t${i}`,
          postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: amt, tag: pick([FloatTag.KESHLESS, FloatTag.CASH_DESK]) },
            { account: { type: LedgerAccountType.WALLET, ref: w }, delta: -amt },
          ],
        });
        owed[w] = (owed[w] ?? 0) + amt;
      } else if (move === 'spend' && (owed[w] ?? 0) > 1) {
        const amt = cents((owed[w] ?? 0) - 1);
        const fee = Math.floor(amt * 0.1);
        const m = pick(merchants);
        await LedgerService.post({
          eventId, refType: 'charge', refId: `c${i}`,
          postings: [
            { account: { type: LedgerAccountType.WALLET, ref: w }, delta: amt },
            { account: { type: LedgerAccountType.MERCHANT, ref: m }, delta: -(amt - fee) },
            { account: { type: LedgerAccountType.FEES }, delta: -fee },
          ],
        });
        owed[w] = (owed[w] ?? 0) - amt;
        earned[m] = (earned[m] ?? 0) + (amt - fee);
      } else if (move === 'refund' && (owed[w] ?? 0) > 0) {
        const amt = owed[w] as number;
        await LedgerService.post({
          eventId, refType: 'refund', refId: `r${i}`,
          postings: [
            { account: { type: LedgerAccountType.WALLET, ref: w }, delta: amt },
            { account: { type: LedgerAccountType.FLOAT }, delta: -amt, tag: FloatTag.KESHLESS },
          ],
        });
        owed[w] = 0;
      }

      // The identity must hold after EVERY transaction, not just at the end.
      const r = await ReconciliationService.checkInvariant(eventId);
      expect(r.drift).toBe(0);
      expect(r.ok).toBe(true);
    }

    // Cross-check the ledger against the independently-tracked mirror.
    const final = await ReconciliationService.checkInvariant(eventId);
    expect(final.walletsOwed).toBe(Object.values(owed).reduce((a, b) => a + b, 0));
    expect(final.merchantsOwed).toBe(Object.values(earned).reduce((a, b) => a + b, 0));
    expect((await ReconciliationService.checkJournalIntegrity(eventId)).ok).toBe(true);
  }, 120000); // 120s timeout per test (60 txns × 3 seeds is slow)
});
