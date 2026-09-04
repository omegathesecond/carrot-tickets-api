import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { Wallet } from '@models/wallet.model';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';

export interface InvariantReport {
  ok: boolean;
  float: number;
  walletsOwed: number;
  merchantsOwed: number;
  feesEarned: number;
  /** float − (walletsOwed + merchantsOwed + feesEarned). Always 0 in a sound journal. */
  drift: number;
}

export interface IntegrityReport {
  ok: boolean;
  unbalancedTxnIds: string[];
}

export interface WalletDrift {
  walletId: string;
  /** The denormalized Wallet.balance. */
  stored: number;
  /** -Σ of this wallet's ledger deltas (the journal's view). */
  journal: number;
  /** stored - journal. Non-zero means the two sources disagree. */
  drift: number;
}

export interface WalletBalanceReport {
  ok: boolean;
  checked: number;
  drifted: WalletDrift[];
  /**
   * Wallets violating `cashFundedBalance <= balance`. Task 1's pre('validate')
   * hook guards ONLY save()/create(); update operators and $inc bypass it
   * entirely, and SP3/SP5 mutate balance with exactly those. So this is the
   * only backstop for that invariant — without it the violation is undetectable,
   * and refunds would route cash-funded money to the wrong channel.
   */
  invariantViolations: string[];
  /**
   * Journal WALLET account refs (sorted) that have no Wallet row in this
   * event. Every wallet posting is keyed by the Wallet _id (wallet.service /
   * merchant.service), so this is money the journal says is owed to a wallet
   * the stored side does not know about — the inverse of `drifted`, which the
   * old per-wallet loop could never see.
   */
  unknownWalletRefs: string[];
}

/** All three checks for one event, run together (see class doc for why together). */
export interface EventReconciliationReport {
  /** True only when every check passes. */
  ok: boolean;
  invariant: InvariantReport;
  journal: IntegrityReport;
  wallets: WalletBalanceReport;
}

export interface SweepReport {
  /** Cashless events in the window that were examined, including those whose check threw. */
  checked: number;
  /** Events where at least one check failed. */
  notOk: string[];
  /** Events whose check threw before producing a report. */
  errored: string[];
}

/** How far back sweepRecentCashlessEvents looks for ended cashless events. */
export const RECENT_CASHLESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reconciliation checks over the cashless ledger (spec §3).
 *
 * These checks detect journal corruption (entries written around LedgerService.post())
 * but do NOT verify that money actually exists. Key limitations:
 *
 * - checkInvariant proves internal consistency only. It does not detect missing money
 *   caused by theft, under-counted physical cash, or failed Keshless settlements.
 * - Both checkInvariant and checkJournalIntegrity are complementary and MUST be run
 *   together. Example: two offsetting rogue writes (FLOAT +1000 alone, WALLET -1000 alone)
 *   produce drift=0 and ok=true from checkInvariant, but checkJournalIntegrity catches
 *   the unbalanced transactions.
 *
 * External reconciliation (comparing ledger float against actual Keshless balance +
 * physical cash on hand) is a separate phase and is the only check that catches
 * real-world loss.
 */
export class ReconciliationService {
  /**
   * Verify the ledger's accounting identity: float == walletsOwed + merchantsOwed + feesEarned.
   *
   * Returns ok: true only if the identity holds exactly (drift === 0). This proves that
   * every posted transaction balanced (summed to zero), so no entries bypassed LedgerService.post().
   *
   * CRITICAL: ok: true does NOT mean money exists. It is an internal consistency check only.
   * It does not compare against Keshless settlement balances or physical cash counts. Use
   * this to detect corruption, but pair it with external reconciliation (money-in-hand vs.
   * ledger float) to catch real-world loss.
   *
   * Must be paired with checkJournalIntegrity(); see class doc for why.
   */
  static async checkInvariant(eventId: string): Promise<InvariantReport> {
    const [float, walletsOwed, merchantsOwed, feesEarned] = await Promise.all([
      LedgerService.floatBalance(eventId),
      LedgerService.totalOwed(eventId, LedgerAccountType.WALLET),
      LedgerService.totalOwed(eventId, LedgerAccountType.MERCHANT),
      LedgerService.totalOwed(eventId, LedgerAccountType.FEES),
    ]);

    const drift = float - (walletsOwed + merchantsOwed + feesEarned);
    return { ok: drift === 0, float, walletsOwed, merchantsOwed, feesEarned, drift };
  }

  /**
   * Verify that every transaction in the journal is balanced (sums to zero).
   *
   * Detects unbalanced transactions that would have been rejected by LedgerService.post().
   * If entries were written directly (bypassing the service), they may be individually unbalanced
   * even if the overall float identity holds. Returns ok: true only if no unbalanced txnIds exist.
   *
   * CRITICAL: Must be paired with checkInvariant(). Example where checkInvariant alone fails:
   * two rogue writes: txn A posts [FLOAT +1000] alone, txn B posts [WALLET -1000] alone.
   * checkInvariant reports ok: true (float = 1000, walletsOwed = 1000, drift = 0), but
   * checkJournalIntegrity catches both as unbalanced. Callers MUST run both checks.
   */
  static async checkJournalIntegrity(eventId: string): Promise<IntegrityReport> {
    const rows = await LedgerEntry.aggregate<{ _id: string; total: number }>([
      { $match: { eventId: new mongoose.Types.ObjectId(eventId) } },
      { $group: { _id: '$txnId', total: { $sum: '$delta' } } },
      { $match: { total: { $ne: 0 } } },
      { $sort: { _id: 1 } },
    ]);

    const unbalancedTxnIds = rows.map((r) => r._id);
    return { ok: unbalancedTxnIds.length === 0, unbalancedTxnIds };
  }

  /**
   * Compare every wallet's denormalized balance against the journal (spec §3,
   * check #2).
   *
   * Unlike checkInvariant — which is tautological, since post() forces every
   * transaction to sum to zero — this compares TWO INDEPENDENT SOURCES: the
   * stored Wallet.balance and -Σ of that wallet's ledger deltas. A bug that
   * mutates a balance without a matching posting (or vice versa) is invisible
   * to checkInvariant and shows up only here. This is the real internal alarm.
   *
   * ONE grouped pass over the journal, not one aggregation per wallet: this
   * runs every 15 minutes in production over every recently-ended cashless
   * event (sweepRecentCashlessEvents), so its cost must not scale with the
   * size of the event. The grouped pass also exposes postings to a wallet ref
   * that has no Wallet row (`unknownWalletRefs`).
   */
  static async checkWalletBalances(eventId: string): Promise<WalletBalanceReport> {
    const oid = new mongoose.Types.ObjectId(eventId);
    const [wallets, rows] = await Promise.all([
      Wallet.find({ eventId: oid })
        .select('_id balance cashFundedBalance')
        .lean<{ _id: mongoose.Types.ObjectId; balance: number; cashFundedBalance: number }[]>(),
      LedgerEntry.aggregate<{ _id: string | null; total: number }>([
        { $match: { eventId: oid, accountType: LedgerAccountType.WALLET } },
        { $group: { _id: '$accountRef', total: { $sum: '$delta' } } },
      ]),
    ]);

    // wallet is credit-normal: owed to the attendee is -Σ delta. `0 - total`,
    // not `-total`, so a wallet whose postings net to zero reads 0, not -0.
    const journalByWallet = new Map<string, number>(rows.map((r) => [String(r._id), 0 - r.total]));

    const drifted: WalletDrift[] = [];
    const invariantViolations: string[] = [];
    for (const w of wallets) {
      const walletId = String(w._id);
      // A wallet with no postings has a journal balance of 0 — a stored balance
      // on such a wallet is drift, not "nothing to compare".
      const journal = journalByWallet.get(walletId) ?? 0;
      journalByWallet.delete(walletId);
      const drift = w.balance - journal;
      if (drift !== 0) drifted.push({ walletId, stored: w.balance, journal, drift });

      // The pre('validate') hook guards only save()/create(); $inc and update
      // operators bypass it, and SP3/SP5 use exactly those. This is the ONLY
      // backstop for the invariant.
      if (w.cashFundedBalance > w.balance) invariantViolations.push(walletId);
    }
    // Whatever the wallets did not claim was posted to a ref with no Wallet row.
    const unknownWalletRefs = [...journalByWallet.keys()].sort();

    return {
      ok: drifted.length === 0 && invariantViolations.length === 0 && unknownWalletRefs.length === 0,
      checked: wallets.length,
      drifted,
      invariantViolations,
      unknownWalletRefs,
    };
  }

  /**
   * All three checks for one event. This is the ONLY entry point production
   * code should use: the class doc explains why checkInvariant and
   * checkJournalIntegrity are meaningless alone, and checkWalletBalances is the
   * one that compares two independent sources. Read-only — nothing is repaired.
   */
  static async checkEvent(eventId: string): Promise<EventReconciliationReport> {
    const [invariant, journal, wallets] = await Promise.all([
      this.checkInvariant(eventId),
      this.checkJournalIntegrity(eventId),
      this.checkWalletBalances(eventId),
    ]);
    return { ok: invariant.ok && journal.ok && wallets.ok, invariant, journal, wallets };
  }

  /**
   * Background alarm: run checkEvent over every cashless event whose end time
   * falls within the last RECENT_CASHLESS_WINDOW_MS and log at ERROR level,
   * with the event id and the drifted wallet ids, whenever anything does not
   * reconcile. Before this existed the checks were referenced only by tests,
   * so a drifted wallet in production had no way to surface.
   *
   * Report-only, like TicketService.reportStuckYocoSales — it never mutates a
   * balance or a posting. A check that throws for one event is logged and
   * counted in `errored` so the remaining events are still examined; it is
   * never swallowed.
   */
  static async sweepRecentCashlessEvents(): Promise<SweepReport> {
    const now = new Date();
    const since = new Date(now.getTime() - RECENT_CASHLESS_WINDOW_MS);
    const events = await Event.find({ cashless: true, endTime: { $gte: since, $lte: now } })
      .select('_id name')
      .lean<{ _id: mongoose.Types.ObjectId; name: string }[]>();

    const notOk: string[] = [];
    const errored: string[] = [];
    for (const event of events) {
      const eventId = String(event._id);
      let report: EventReconciliationReport;
      try {
        report = await ReconciliationService.checkEvent(eventId);
      } catch (error) {
        console.error('[cashless-reconcile] check threw — event NOT verified', {
          eventId, eventName: event.name, error,
        });
        errored.push(eventId);
        continue;
      }
      if (report.ok) continue;

      notOk.push(eventId);
      console.error('[cashless-reconcile] ledger does NOT reconcile — needs manual investigation', {
        eventId,
        eventName: event.name,
        driftedWalletIds: report.wallets.drifted.map((d) => d.walletId),
        drifted: report.wallets.drifted,
        invariantViolations: report.wallets.invariantViolations,
        unknownWalletRefs: report.wallets.unknownWalletRefs,
        unbalancedTxnIds: report.journal.unbalancedTxnIds,
        identityDrift: report.invariant.drift,
      });
    }
    return { checked: events.length, notOk, errored };
  }
}
