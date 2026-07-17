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

/**
 * The five real money movements of spec §3. The walk must reach EVERY one, or it
 * is only claiming to prove money-in = money-out. Top-up is split by float tag
 * because the spec treats card/MoMo (settled into Keshless) and the cash desk
 * (physical notes in a drawer) as distinct movements.
 */
const MOVEMENTS = ['topupCard', 'topupCash', 'spend', 'withdraw', 'refund'] as const;
type Movement = (typeof MOVEMENTS)[number];

/**
 * Tap-to-pay commission: 10%, floored. Integer math ONLY — `amt * 0.1` is
 * floating point applied to a money value, the exact sin this file exists to
 * police. `amt / 10` under Math.floor is exact for every safe integer amt.
 */
const feeOf = (amt: number): number => Math.floor(amt / 10);

/**
 * Smallest spend that still produces a non-zero FEES leg (feeOf(9) === 0).
 * Spends are floored here rather than dropping the fees posting when it rounds
 * to zero: it keeps the tap-to-pay shape constant at three legs, so the FEES
 * aggregation and its mirror are exercised on every single spend instead of
 * only on the large ones — and it never writes a zero-delta leg.
 */
const MIN_SPEND = 10;

describe('ledger invariant (property)', () => {
  beforeAll(connectLedgerTestDb, 60000); // replica set: post() commits in a transaction
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it.each([1, 2, 3])('holds across a random 60-transaction sequence (seed %i)', async (seed) => {
    const eventId = new mongoose.Types.ObjectId().toString();
    const rand = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    /** Integer cents in [min, max] inclusive. */
    const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
    const sum = (xs: Record<string, number>) => Object.values(xs).reduce((a, b) => a + b, 0);

    const wallets = ['w1', 'w2', 'w3'];
    const merchants = ['m1', 'm2'];

    // Mirror of the ledger, tracked independently in memory. This is the test's
    // real content: every figure the ledger aggregates out of Mongo is compared
    // against a number we computed ourselves, from the same movements, by hand.
    const owed: Record<string, number> = { w1: 0, w2: 0, w3: 0 };
    const earned: Record<string, number> = { m1: 0, m2: 0 };
    let fees = 0;
    const floatByTag: Record<FloatTag, number> = {
      [FloatTag.KESHLESS]: 0,
      [FloatTag.CASH_DESK]: 0,
    };

    // A guard that silently stops matching (a refactor, a flipped comparison)
    // turns iterations into no-ops: the test stays green while proving strictly
    // less. Count what actually ran and assert coverage at the end.
    const walked: Record<Movement, number> = {
      topupCard: 0, topupCash: 0, spend: 0, withdraw: 0, refund: 0,
    };

    for (let i = 0; i < 60; i++) {
      // Choose only among movements that are ACTUALLY possible in this state, so
      // a pick can never degrade into a skipped iteration. Weights keep money
      // flowing in faster than it drains, so the walk stays live for 60 txns.
      const spendable = wallets.filter((w) => (owed[w] ?? 0) >= MIN_SPEND);
      const refundable = wallets.filter((w) => (owed[w] ?? 0) > 0);
      const payable = merchants.filter((m) => (earned[m] ?? 0) > 0);

      const choices: Movement[] = ['topupCard', 'topupCard', 'topupCash', 'topupCash'];
      if (spendable.length) choices.push('spend', 'spend', 'spend');
      if (payable.length) choices.push('withdraw', 'withdraw');
      if (refundable.length) choices.push('refund');
      const move = pick(choices);

      if (move === 'topupCard' || move === 'topupCash') {
        // float +X, wallet -X. Money enters custody.
        const tag = move === 'topupCard' ? FloatTag.KESHLESS : FloatTag.CASH_DESK;
        const w = pick(wallets);
        const amt = between(1, 10_000);
        await LedgerService.post({
          eventId, refType: 'topup', refId: `t${i}`,
          postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: amt, tag },
            { account: { type: LedgerAccountType.WALLET, ref: w }, delta: -amt },
          ],
        });
        owed[w] = (owed[w] ?? 0) + amt;
        floatByTag[tag] += amt;
      } else if (move === 'spend') {
        // wallet +X, merchant -(X-f), fees -f. Custody is unchanged; the claim
        // on it moves from an attendee to a merchant and to us.
        const w = pick(spendable);
        const m = pick(merchants);
        const amt = between(MIN_SPEND, owed[w] as number);
        const fee = feeOf(amt);
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
        fees += fee;
      } else if (move === 'withdraw') {
        // merchant +X, float -X. The FLOAT↔MERCHANT debit path — the only
        // movement that pays custody back out to anyone but the attendee.
        // Capped at what this merchant has actually earned: a withdrawal is a
        // payout of real earnings, never an overdraft.
        const m = pick(payable);
        const amt = between(1, earned[m] as number);
        await LedgerService.post({
          eventId, refType: 'withdrawal', refId: `x${i}`,
          postings: [
            { account: { type: LedgerAccountType.MERCHANT, ref: m }, delta: amt },
            { account: { type: LedgerAccountType.FLOAT }, delta: -amt, tag: FloatTag.KESHLESS },
          ],
        });
        earned[m] = (earned[m] ?? 0) - amt;
        floatByTag[FloatTag.KESHLESS] -= amt;
      } else {
        // wallet +X, float -X. Money leaves custody back to the attendee.
        const w = pick(refundable);
        const amt = owed[w] as number;
        await LedgerService.post({
          eventId, refType: 'refund', refId: `r${i}`,
          postings: [
            { account: { type: LedgerAccountType.WALLET, ref: w }, delta: amt },
            { account: { type: LedgerAccountType.FLOAT }, delta: -amt, tag: FloatTag.KESHLESS },
          ],
        });
        owed[w] = 0;
        floatByTag[FloatTag.KESHLESS] -= amt;
      }
      walked[move]++;

      const r = await ReconciliationService.checkInvariant(eventId);

      // THE assertion: what Mongo aggregates vs what we tracked independently.
      // After EVERY transaction, so a divergence names the txn that caused it
      // instead of surfacing 60 movements later with no way back to the culprit.
      expect(r.walletsOwed).toBe(sum(owed));
      expect(r.merchantsOwed).toBe(sum(earned));
      expect(r.feesEarned).toBe(fees);
      expect(r.float).toBe(floatByTag[FloatTag.KESHLESS] + floatByTag[FloatTag.CASH_DESK]);

      // Near-tautological: LedgerAccountType has exactly these four members and
      // drift sums all four, so drift === Σ(every delta) — which post() already
      // forces to 0 per txn. It is NOT the proof this test rests on. Kept because
      // it still catches a $match/sign bug in sumDeltas or totalOwed's `0 - total`,
      // and a post() that landed only some of its legs. Cheap; just not evidence.
      expect(r.drift).toBe(0);
      expect(r.ok).toBe(true);
    }

    // Money must reconcile per LOCATION, not only in total: a bug that credited
    // the cash drawer for a card top-up nets out of `float` and hides here.
    expect(await LedgerService.floatBalance(eventId, FloatTag.KESHLESS))
      .toBe(floatByTag[FloatTag.KESHLESS]);
    expect(await LedgerService.floatBalance(eventId, FloatTag.CASH_DESK))
      .toBe(floatByTag[FloatTag.CASH_DESK]);

    // Per-account, not just the type-wide totals the invariant sums: crossed
    // wallets (w1 debited for w2's spend) cancel inside walletsOwed.
    for (const w of wallets) {
      expect(await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: w }))
        .toBe(0 - (owed[w] as number));
    }
    for (const m of merchants) {
      expect(await LedgerService.accountBalance(eventId, { type: LedgerAccountType.MERCHANT, ref: m }))
        .toBe(0 - (earned[m] as number));
    }

    expect((await ReconciliationService.checkJournalIntegrity(eventId)).ok).toBe(true);

    // Every movement in spec §3 must have been walked, or this seed proved less
    // than it claims. Fails as e.g. Received: ["withdraw"], naming what the walk
    // missed. If a seed cannot reach a branch, fix the walk — never this.
    expect(MOVEMENTS.filter((m) => walked[m] === 0)).toEqual([]);
  }, 120000); // 120s timeout per test (60 txns × 3 seeds is slow)
});
