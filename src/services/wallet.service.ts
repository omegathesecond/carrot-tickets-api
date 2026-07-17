import mongoose from 'mongoose';
import { Wallet, IWallet } from '@models/wallet.model';

/**
 * Wallet lifecycle for the per-event closed-loop cashless wallet (spec §4, §5.1).
 *
 * This service does NOT mutate `balance` — top-up (SP3) and tap-to-pay (SP5) do,
 * each through an atomic CAS plus a balanced ledger posting.
 */
export class WalletService {
  /**
   * Get-or-create this attendee's wallet for one event. Idempotent and
   * concurrency-safe.
   *
   * The safety comes from the PARTIAL UNIQUE index on {eventId, buyerId}, not
   * from the upsert itself: an upsert only serialises concurrent callers when a
   * unique index backs its filter — otherwise two simultaneous check-in scans
   * both miss and both insert, minting two wallets for one attendee. When the
   * index arbitrates, the loser gets an E11000 and simply re-reads the winner.
   */
  static async ensureWallet(eventId: string, buyerId: string): Promise<IWallet> {
    const filter = {
      eventId: new mongoose.Types.ObjectId(eventId),
      buyerId: new mongoose.Types.ObjectId(buyerId),
    };
    try {
      return await Wallet.findOneAndUpdate(
        filter,
        { $setOnInsert: { ...filter, balance: 0, cashFundedBalance: 0, status: 'active' } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      if ((err as { code?: number })?.code !== 11000) throw err;
      // Only the {eventId, buyerId} index describes the race this re-read
      // resolves. Discriminating on `code` alone would also swallow an E11000
      // from the {eventId, bandUid} index and hand back a wallet that has
      // nothing to do with the failure — silently, whenever a matching wallet
      // happens to exist (which defeats the `!existing` backstop below).
      // Unreachable today (this insert always leaves bandUid null, which that
      // partial index excludes), but a trap for a later
      // ensureWallet(eventId, buyerId, bandUid).
      if (!(err as { keyPattern?: Record<string, unknown> })?.keyPattern?.buyerId) throw err;
      // Lost the insert race: the winner's wallet is the one true wallet.
      const existing = await Wallet.findOne(filter);
      if (!existing) throw err; // E11000 with no winner => a different index; surface it.
      return existing;
    }
  }
}
