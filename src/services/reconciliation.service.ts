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
 * The identity float == walletsOwed + merchantsOwed + feesEarned is
 * mathematically guaranteed while every transaction sums to zero, so a
 * non-zero drift means something wrote entries WITHOUT going through
 * LedgerService.post(). That is exactly what these tripwires exist to catch.
 */
export class ReconciliationService {
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
