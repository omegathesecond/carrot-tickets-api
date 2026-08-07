import mongoose from 'mongoose';
import { Wallet, IWallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';

/**
 * Wallet lifecycle for the per-event closed-loop cashless wallet (spec §4, §5.1).
 *
 * This service does NOT mutate `balance` — top-up (SP3) and tap-to-pay (SP5) do,
 * each through an atomic CAS plus a balanced ledger posting.
 */
export class WalletService {
  /**
   * Get-or-create the wallet for one TICKET (the chosen identity: one wallet per
   * ticket). Idempotent and concurrency-safe via the unique index on ticketId —
   * the upsert only serialises concurrent callers because that index arbitrates;
   * the loser gets an E11000 and re-reads the winner.
   */
  static async ensureWalletForTicket(params: {
    ticketId: string;
    eventId: string;
    buyerId?: string;
  }): Promise<IWallet> {
    const filter = { ticketId: new mongoose.Types.ObjectId(params.ticketId) };
    const insert = {
      ...filter,
      eventId: new mongoose.Types.ObjectId(params.eventId),
      ...(params.buyerId ? { buyerId: new mongoose.Types.ObjectId(params.buyerId) } : {}),
      balance: 0,
      cashFundedBalance: 0,
      status: 'active',
    };
    try {
      return await Wallet.findOneAndUpdate(
        filter,
        { $setOnInsert: insert },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      if ((err as { keyPattern?: Record<string, unknown> })?.keyPattern?.ticketId === undefined) {
        throw err; // a DIFFERENT index conflicted — surface it
      }
      const existing = await Wallet.findOne(filter);
      if (!existing) throw err;
      return existing;
    }
  }

  /**
   * Bind a blank client band's UID to an unbound, active wallet (spec §5.1).
   *
   * Two distinct races are guarded, in this order:
   *  1. Two operators banding the SAME wallet — the `bandUid: null` precondition
   *     lives inside the filter, so MongoDB's single-document atomicity lets
   *     exactly one win.
   *  2. Two operators binding the SAME uid to DIFFERENT wallets — caught by the
   *     partial unique index on {eventId, bandUid} as an E11000. The claim is
   *     rolled back so the loser leaves no half-bound wallet behind.
   *
   * The audit row is written only after the uid is safely claimed, so a losing
   * caller never leaves a BandBinding for a band it does not hold.
   */
  static async bindBand(walletId: string, bandUid: string, boundBy?: string): Promise<IWallet> {
    const uid = bandUid.trim();
    if (!uid) throw new Error('bandUid is required');

    // Race 1: claim the wallet. Precondition in the filter => one winner.
    const claimed = await Wallet.findOneAndUpdate(
      { _id: walletId, status: 'active', bandUid: null },
      { $set: { bandUid: uid } },
      { new: true },
    ).catch((err: { code?: number; keyPattern?: Record<string, unknown> }) => {
      // Race 2 surfaced during the claim itself. Discriminate by keyPattern the
      // way ensureWallet does: ONLY a duplicate key on the {eventId, bandUid}
      // partial unique index describes this race. Mapping on `code === 11000`
      // alone would mislabel an E11000 raised by any other index as "already
      // bound". A $set:{bandUid} on a fixed _id can only violate that one index
      // today, so this is defensive/symmetric rather than reachable — but cheap.
      if (!err?.keyPattern?.bandUid) throw err;
      throw new Error('band is already bound to another wallet at this event');
    });

    if (!claimed) {
      // Distinguish the failure so the operator gets a true message, rather
      // than a generic "could not bind". This re-read is best-effort: a rare
      // interleaving (the wallet being unbound or reactivated between the failed
      // claim and this read) can pick the wrong branch, and thus the wrong
      // MESSAGE — but the claim already failed authoritatively, so at most the
      // explanation is stale, never the outcome. Not worth a retry loop.
      const fresh = await Wallet.findById(walletId);
      if (!fresh) throw new Error('wallet not found');
      if (fresh.status !== 'active') throw new Error('wallet is not active');
      throw new Error('wallet already has a band bound');
    }

    // The claim (bandUid now set) and this audit row are two separate writes,
    // not one atomic unit. We deliberately do NOT wrap them in a transaction: a
    // transaction would force this check-in path onto a replica set, but it must
    // keep running on the standalone mongod harness (and standalone nodes). So
    // compensate instead — if the audit write fails, roll the claim back by
    // unsetting bandUid, restoring the "either both the claim and the audit row
    // exist, or neither does" invariant. Otherwise a band is left bound with no
    // forensic row for the clone/reissue trail.
    try {
      await BandBinding.create({
        walletId: claimed._id,
        eventId: claimed.eventId,
        bandUid: uid,
        boundAt: new Date(),
        ...(boundBy ? { boundBy } : {}),
      });
    } catch (auditErr) {
      try {
        // Roll back ONLY the uid this call claimed — the compensating write is
        // itself a CAS, matching {_id, bandUid: uid}, exactly like every other
        // wallet mutation in this file. An unconditional `{_id}` update would
        // clobber a later LEGAL rebind: if the wallet was unbound and rebound to
        // a different uid between our failed audit and this rollback, unsetting
        // bandUid unconditionally would strip that new uid, leaving a physically
        // bound band with a live audit row but an unbound wallet.
        //
        // A zero-match here is therefore NOT a failure: it means a concurrent
        // rebind already moved this band, so our claim was superseded and there
        // is nothing to undo. Only a thrown error is treated as a rollback
        // failure below.
        await Wallet.updateOne({ _id: claimed._id, bandUid: uid }, { $set: { bandUid: null } });
      } catch (rollbackErr) {
        // Rollback is best-effort but LOUD: if it too fails, a band may be stuck
        // bound with NO audit row. Surface BOTH failures so on-call sees the
        // band that needs manual unbinding, not just the audit error.
        throw new Error(
          `band binding audit write failed AND rollback failed — wallet ${String(claimed._id)} may be stuck bound to uid ${uid}. ` +
            `audit error: ${(auditErr as Error)?.message ?? String(auditErr)}; ` +
            `rollback error: ${(rollbackErr as Error)?.message ?? String(rollbackErr)}`,
        );
      }
      // Claim rolled back cleanly; surface the ORIGINAL audit failure loudly.
      throw auditErr;
    }

    return claimed;
  }

  /**
   * Release a band from a wallet — the lost-band path (spec §5.1).
   *
   * The balance is deliberately untouched: it lives on the wallet, not the band,
   * so a lost band costs the attendee nothing and staff can reissue a new one by
   * calling bindBand() again. Releasing also frees the UID for reuse.
   */
  static async unbindBand(walletId: string, reason: string): Promise<IWallet> {
    // Precondition in the filter: only a wallet that HAS a band can be unbound,
    // so two concurrent unbinds cannot both stamp the audit row.
    const released = await Wallet.findOneAndUpdate(
      { _id: walletId, bandUid: { $ne: null } },
      { $set: { bandUid: null } },
      { new: true },
    );

    if (!released) {
      const fresh = await Wallet.findById(walletId);
      if (!fresh) throw new Error('wallet not found');
      throw new Error('wallet has no band bound');
    }

    // Stamp the live binding row closed. Scoped to the row without unboundAt so
    // an earlier, already-closed binding for the same uid is never re-stamped.
    await BandBinding.findOneAndUpdate(
      { walletId: released._id, unboundAt: { $exists: false } },
      { $set: { unboundAt: new Date(), unboundReason: reason } },
    );

    return released;
  }
}
