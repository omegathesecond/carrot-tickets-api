import mongoose from 'mongoose';
import { LedgerEntry } from '@models/ledgerEntry.model';
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
}
