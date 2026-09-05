import mongoose from 'mongoose';
import { Wallet, IWallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';
import { EventTagService } from '@services/eventTag.service';
import { WalletTopup, IWalletTopup, TopupRecordedByType } from '@models/walletTopup.model';
import { WalletWithdrawal, IWalletWithdrawal } from '@models/walletWithdrawal.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';
import { WalletDeclinedError } from '@services/merchant.service';
import { assertValidBandUid } from '@utils/bandUid.util';

/**
 * Safety ceiling on a single cash top-up, in minor units (cents): R100,000.
 * This is an adjustable defense-in-depth limit against ledger inflation from a
 * fat-fingered or malicious amount — NOT a business rule. Enforced both in the
 * reseller Joi schema (cashTopupSchema.amount) and here in topUpCash, so a
 * caller that bypasses validation still cannot inflate.
 */
export const MAX_TOPUP_CENTS = 10_000_000;

/**
 * A replay of a {walletId, clientTxnId} that asks for a DIFFERENT amount than
 * the one already recorded. That is not a retry — it is a second, contradicting
 * instruction under a reused id. Answering it with the original outcome would
 * tell the desk "done" while the wallet holds something else, so it is refused
 * and the controllers map it to a 409. A true replay (same amount) still
 * returns the original row.
 */
export class WalletIdempotencyMismatchError extends Error {
  readonly reason = 'idempotency_mismatch' as const;
  constructor(
    public readonly recordedAmount: number,
    public readonly requestedAmount: number,
  ) {
    super('clientTxnId already used with a different amount');
    this.name = 'WalletIdempotencyMismatchError';
  }
}

function assertReplayMatches(recordedAmount: number, requestedAmount: number): void {
  if (recordedAmount !== requestedAmount) {
    throw new WalletIdempotencyMismatchError(recordedAmount, requestedAmount);
  }
}

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
  /**
   * Get-or-create the wallet for a tag handed out ON ITS OWN — no ticket behind
   * it (design 2026-09-05). The band IS this wallet's identity.
   *
   * Idempotent for free, which is the payoff of that identity choice: a desk
   * operator tapping the same tag twice finds the wallet already there rather
   * than minting a second one, with no clientTxnId to carry.
   *
   * WHY THIS CREATES THE WALLET WITH ITS UID ALREADY SET, rather than creating
   * it unbound and calling bindBand: a wallet with neither a ticket nor a band
   * is refused by the schema (it would be reachable by no lookup), so the
   * unbound draft that a create-then-bind sequence needs cannot legally exist.
   * The register gate is therefore applied HERE, through the same two
   * assertions bindBand uses — assertValidBandUid and assertTagRegistered. The
   * invariant that matters is not "one function" but "no uid ever reaches a
   * wallet without passing the register gate", and both writers enforce it.
   * Any third writer must too.
   */
  static async ensureStandaloneWalletForBand(params: {
    eventId: string;
    bandUid: string;
    /** The desk operator who handed it out, for the binding trail. */
    issuedBy?: string;
    /**
     * Treat a tag that already carries a TICKET's wallet as already-ready
     * rather than refusing it. Set by the register scan, whose only question is
     * "can this tag hold money yet" — it can. The explicit hand-out action
     * leaves it off, because there "this is not a blank" is exactly what the
     * operator needs told.
     */
    acceptTicketBound?: boolean;
  }): Promise<{ wallet: IWallet; created: boolean }> {
    // Normalise + shape-check FIRST, so a malformed uid is refused before any
    // read or write — and so the lookup below uses the canonical form every
    // money path reads (see the normalisation note in bindBand).
    const uid = assertValidBandUid(params.bandUid);
    const eventId = new mongoose.Types.ObjectId(params.eventId);

    const existing = await Wallet.findOne({ eventId, bandUid: uid });
    if (existing) {
      // A tag already carrying somebody's ticket is not a blank to hand out.
      // Distinguished from "not registered" on purpose: at a busy desk these
      // call for opposite actions.
      if (existing.ticketId && !params.acceptTicketBound) {
        throw new Error('That tag belongs to a ticket at this event');
      }
      return { wallet: existing, created: false };
    }

    await EventTagService.assertTagRegistered(params.eventId, uid);

    try {
      const wallet = await Wallet.create({
        eventId, bandUid: uid, balance: 0, cashFundedBalance: 0, status: 'active',
      });
      // The append-only binding trail is not optional bookkeeping: a UID-only
      // band is cloneable, so "which band was live on this wallet, and when"
      // must stay answerable for reissue and clone forensics (cashless spec
      // §4). bindBand writes this row for every other binding; a standalone tag
      // that skipped it would be invisible to the tag-registrations report and
      // to any later investigation.
      await BandBinding.create({
        walletId: wallet._id,
        eventId: wallet.eventId,
        bandUid: uid,
        boundAt: new Date(),
        ...(params.issuedBy ? { boundBy: params.issuedBy } : {}),
      });
      return { wallet, created: true };
    } catch (err) {
      // Lost the race to a concurrent tap of the same tag — the partial unique
      // index on {eventId, bandUid} arbitrates and the loser re-reads the
      // winner, the same shape ensureWalletForTicket uses. Discriminated by
      // keyPattern so an E11000 from any OTHER index is not mislabelled.
      if (!(err as { keyPattern?: Record<string, unknown> })?.keyPattern?.bandUid) throw err;
      const winner = await Wallet.findOne({ eventId, bandUid: uid });
      if (!winner) throw err;
      if (winner.ticketId && !params.acceptTicketBound) {
        throw new Error('That tag belongs to a ticket at this event');
      }
      return { wallet: winner, created: false };
    }
  }

  static async bindBand(walletId: string, bandUid: string, boundBy?: string): Promise<IWallet> {
    // THE NORMALISATION POINT. Readers hand a uid over as `04:B2:C3:D4`, or
    // upper-case, or with spaces; every money path (top-up, charge, cash-out,
    // check-in-by-tag) looks the wallet up by the CANONICAL form. Storing the
    // raw string here meant those lookups found no wallet — and, because the
    // {eventId, bandUid} unique index compares strings, the same physical tag
    // could then be bound to a second wallet under another spelling. So the
    // uid is canonicalised (and shape-checked) before any read or write.
    const uid = assertValidBandUid(bandUid);

    // THE ALLOWLIST GATE. A tag only carries money at an event its organizer
    // enrolled it into (see EventTag) — otherwise anyone could arrive with a
    // tag bought elsewhere, or one left over from last night's show, and spend
    // against this organizer's float.
    //
    // This is deliberately THE choke point rather than one check per caller:
    // binding is the only way a uid ever lands on a wallet, so gating it here
    // means check-in-by-tag, vendor charges and wallet lookups are all covered
    // for free — they can only ever find a wallet whose uid passed through
    // this line. Reissue-onto-a-fresh-tag comes through here too.
    //
    // The wallet is read first purely for its eventId: the register is
    // per-event, and bindBand is addressed by walletId.
    const target = await Wallet.findById(walletId).select('eventId').lean<{ eventId: unknown } | null>();
    if (!target) throw new Error('wallet not found');
    await EventTagService.assertTagRegistered(String(target.eventId), uid);

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

    // Stamp the live binding row closed — the MOST RECENT open one. Scoped to
    // rows without unboundAt so an earlier, already-closed binding for the same
    // uid is never re-stamped; sorted because more than one open row can exist
    // (a compensated reissue re-binds the old uid on a fresh row) and without
    // a sort MongoDB hands back whichever it likes, closing the wrong one.
    //
    // The wallet is already released at this point. A failed stamp would leave
    // it unbound with an open audit row — a silent lie in the forensic trail —
    // so the failure is logged with the wallet it concerns and rethrown, never
    // swallowed.
    let stamped: unknown;
    try {
      stamped = await BandBinding.findOneAndUpdate(
        { walletId: released._id, unboundAt: { $exists: false } },
        { $set: { unboundAt: new Date(), unboundReason: reason } },
        { sort: { boundAt: -1 }, new: true },
      );
    } catch (stampErr) {
      console.error(
        `unbindBand: wallet ${String(released._id)} was released (reason: ${reason}) but its BandBinding audit row could not be stamped`,
        stampErr,
      );
      throw stampErr;
    }
    if (!stamped) {
      // Nothing to close: the wallet carried a uid with no open audit row (a
      // seed or a hand edit). Not a failure of this release, but not normal
      // either — say so where on-call will see it.
      console.warn(`unbindBand: wallet ${String(released._id)} had no open BandBinding row to stamp (reason: ${reason})`);
    }

    return released;
  }

  /**
   * Reissue: release the wallet's current tag (if any) and bind `newBandUid`
   * to the SAME wallet, balance untouched — the whole payoff of keeping the
   * balance on the wallet rather than the plastic.
   *
   * Everything that can refuse the replacement is checked BEFORE the old tag
   * is released: uid shape, registration for this event (which also excludes
   * a retired tag), and not already live on another wallet. The old order —
   * unbind, then let bindBand do the checking — returned the operator a 400
   * and left the attendee holding a tag that no longer worked.
   *
   * The pre-flight is read-only, so a race between it and the claim is still
   * possible (another desk grabs the uid in between). If the bind fails after
   * the release, the old uid is re-bound as compensation — the trail shows the
   * release and the restore honestly — and the bind's error is rethrown.
   */
  static async reissueBand(
    walletId: string,
    newBandUid: string,
    reason: string,
    boundBy?: string,
  ): Promise<IWallet> {
    const uid = assertValidBandUid(newBandUid);

    const current = await Wallet.findById(walletId)
      .select('eventId bandUid status')
      .lean<{ eventId: unknown; bandUid: string | null; status: string } | null>();
    if (!current) throw new Error('wallet not found');
    if (current.status !== 'active') throw new Error('wallet is not active');
    const eventId = String(current.eventId);

    // Pre-flight — nothing written yet.
    await EventTagService.assertTagRegistered(eventId, uid);
    const taken = await Wallet.exists({ eventId, bandUid: uid, _id: { $ne: walletId } });
    if (taken) throw new Error('band is already bound to another wallet at this event');

    const previous = current.bandUid;
    if (previous) await WalletService.unbindBand(walletId, reason);

    try {
      return await WalletService.bindBand(walletId, uid, boundBy);
    } catch (bindErr) {
      if (!previous) throw bindErr;
      try {
        // Same path as any bind, so the restore leaves its own audit row.
        await WalletService.bindBand(walletId, previous, boundBy);
      } catch (restoreErr) {
        throw new Error(
          `reissue failed AND the old tag could not be restored — wallet ${walletId} is now unbound (was ${previous}). ` +
            `reissue error: ${(bindErr as Error)?.message ?? String(bindErr)}; ` +
            `restore error: ${(restoreErr as Error)?.message ?? String(restoreErr)}`,
        );
      }
      throw bindErr;
    }
  }

  /**
   * Cash top-up at a desk (spec §5.2): credit `balance` and `cashFundedBalance`
   * together, and post the matching balanced ledger transaction (cash desk
   * float goes up; the wallet liability goes up), all inside one multi-document
   * transaction so the wallet mutation and its ledger legs can never diverge.
   *
   * Idempotent on `clientTxnId` (a client-generated id, e.g. offline-safe POS
   * retry): a repeat call with the same id returns the ORIGINAL outcome rather
   * than crediting twice. Two layers enforce this:
   *  1. A pre-check read, to short-circuit the common case cheaply.
   *  2. The unique index on WalletTopup.clientTxnId, to close the race when two
   *     concurrent calls both pass the pre-check — the loser's insert throws
   *     E11000 inside the transaction (which aborts it, undoing its wallet
   *     credit and ledger legs), and we then re-read and return the winner's
   *     row instead of the loser's failure.
   */
  static async topUpCash(params: {
    walletId: string;
    eventId: string;
    amount: number;
    recordedBy: string;
    /** Actor population recording the top-up. Defaults to ResellerOperator — the
     * only historical caller — so the reseller desk path is unchanged; the
     * cashier desk passes 'Cashier'. */
    recordedByType?: TopupRecordedByType;
    clientTxnId: string;
  }): Promise<{ wallet: IWallet; topup: IWalletTopup }> {
    const { walletId, eventId, amount, recordedBy, clientTxnId } = params;
    const recordedByType: TopupRecordedByType = params.recordedByType ?? 'ResellerOperator';
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer (cents)');
    }
    // Defense in depth against ledger inflation: reject an absurd amount even if
    // a caller reached this service without passing the Joi ceiling.
    if (amount > MAX_TOPUP_CENTS) {
      throw new Error('amount exceeds the maximum allowed top-up');
    }

    // Idempotency: if this clientTxnId already ran FOR THIS WALLET, return the
    // existing outcome. Scoped to walletId — the same clientTxnId on a different
    // wallet is a different, legitimate top-up, not a duplicate of this one.
    // A replay is only a replay if it asks for the same amount — see
    // WalletIdempotencyMismatchError.
    const existing = await WalletTopup.findOne({ walletId, clientTxnId });
    if (existing) {
      assertReplayMatches(existing.amount, amount);
      const w = await Wallet.findById(existing.walletId);
      if (!w) throw new Error('wallet not found');
      return { wallet: w, topup: existing };
    }

    const session = await mongoose.startSession();
    try {
      let out!: { wallet: IWallet; topup: IWalletTopup };
      await session.withTransaction(async () => {
        // Atomic credit; pipeline update keeps balance & cashFundedBalance
        // consistent (the model's cashFundedBalance<=balance pre('validate')
        // hook does NOT fire on updates — see wallet.model.ts).
        //
        // eventId is part of the CAS, as in withdrawCash and MerchantService:
        // the ledger legs below are posted under `eventId`, so a walletId-keyed
        // caller must never be able to credit a wallet under the wrong event.
        const wallet = await Wallet.findOneAndUpdate(
          { _id: walletId, eventId, status: 'active' },
          [
            {
              $set: {
                balance: { $add: ['$balance', amount] },
                cashFundedBalance: { $add: ['$cashFundedBalance', amount] },
              },
            },
          ],
          { new: true, session },
        );
        if (!wallet) throw new Error('wallet not found or not active');

        await LedgerService.post({
          eventId,
          postings: [
            { account: { type: LedgerAccountType.FLOAT }, delta: amount, tag: FloatTag.CASH_DESK },
            { account: { type: LedgerAccountType.WALLET, ref: walletId }, delta: -amount },
          ],
          refType: 'wallet_topup',
          refId: clientTxnId,
          session,
        });

        const [topup] = await WalletTopup.create(
          [{ walletId, eventId, amount, method: 'cash', status: 'completed', recordedBy, recordedByType, clientTxnId }],
          { session },
        );
        if (!topup) throw new Error('wallet topup insert failed');

        out = { wallet, topup };
      });
      return out;
    } catch (e) {
      // Concurrent duplicate: the {walletId, clientTxnId} unique index lost the
      // race — re-read the winner with the SAME scoped filter so we never return
      // a different wallet's row.
      if ((e as { code?: number })?.code === 11000) {
        const topup = await WalletTopup.findOne({ walletId, clientTxnId });
        const wallet = topup ? await Wallet.findById(topup.walletId) : null;
        if (topup && wallet) {
          assertReplayMatches(topup.amount, amount);
          return { wallet, topup };
        }
      }
      throw e;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Cash-OUT at a desk (cashless spec — cashier slice): the mirror image of
   * topUpCash. A cashier hands physical cash back to the attendee, so we DEBIT
   * the wallet and pay the venue's cash float down.
   *
   * Money direction and safety are borrowed wholesale from MerchantService.charge:
   *  - Atomic CAS debit — the guard (active + sufficient balance) and the
   *    decrement are ONE operation, so no concurrent desk can push the balance
   *    negative; a DECLINE (insufficient / inactive / missing) throws
   *    WalletDeclinedError and leaves the wallet, ledger and withdrawal
   *    collection completely untouched.
   *  - cashFundedBalance is drawn down first and floored at 0 via $max. Per the
   *    client-confirmed rule "cash back = full remaining balance", a cash-out
   *    MAY exceed cashFundedBalance (returning card/MoMo-loaded value as cash);
   *    the $max floor keeps the field valid while the full `amount` still leaves
   *    the wallet. (Today only cash top-up exists, so the two are always equal.)
   *  - Idempotent on {walletId, clientTxnId}, including E11000 re-read recovery.
   *
   * Ledger (reverse of top-up, sum of deltas = 0, so the invariant holds):
   *   WALLET:ref  += amount   (attendee liability reduced)
   *   FLOAT       -= amount   (cash paid out of the desk)
   */
  static async withdrawCash(params: {
    walletId: string;
    eventId: string;
    amount: number;
    recordedBy: string;
    clientTxnId: string;
    /**
     * Money leaving a wallet is one movement with more than one story: a
     * cashier hands cash over a desk at the venue, or the office hands a
     * residual balance back afterwards. Same CAS, same balanced posting, same
     * idempotency — only the labelling differs, so these are options rather
     * than a second copy of the routine. Defaults keep the cashier path
     * byte-identical.
     */
    method?: 'cash' | 'office_cash';
    recordedByType?: 'Cashier' | 'Vendor';
    floatTag?: FloatTag;
  }): Promise<{ wallet: IWallet; withdrawal: IWalletWithdrawal }> {
    const {
      walletId, eventId, amount, recordedBy, clientTxnId,
      method = 'cash', recordedByType = 'Cashier', floatTag = FloatTag.CASH_DESK,
    } = params;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer (cents)');
    }
    // Same defense-in-depth ceiling as top-up/charge against a fat-fingered amount.
    if (amount > MAX_TOPUP_CENTS) {
      throw new Error('amount exceeds the maximum allowed withdrawal');
    }

    // Idempotency: a genuine retry for THIS wallet (same amount) returns the
    // original outcome; a reused id with a different amount is refused.
    const existing = await WalletWithdrawal.findOne({ walletId, clientTxnId });
    if (existing) {
      assertReplayMatches(existing.amount, amount);
      const w = await Wallet.findById(existing.walletId);
      if (!w) throw new Error('wallet not found');
      return { wallet: w, withdrawal: existing };
    }

    const session = await mongoose.startSession();
    try {
      let out!: { wallet: IWallet; withdrawal: IWalletWithdrawal };
      await session.withTransaction(async () => {
        const wallet = await Wallet.findOneAndUpdate(
          { _id: walletId, eventId, status: 'active', balance: { $gte: amount } },
          [
            {
              $set: {
                balance: { $subtract: ['$balance', amount] },
                cashFundedBalance: { $max: [0, { $subtract: ['$cashFundedBalance', amount] }] },
              },
            },
          ],
          { new: true, session },
        );

        if (!wallet) {
          // DECLINE — nothing written yet; re-read only to report a true reason.
          const fresh = await Wallet.findOne({ _id: walletId, eventId }).session(session);
          if (!fresh) throw new WalletDeclinedError('wallet_not_found', 'wallet not found', null);
          if (fresh.status !== 'active') {
            throw new WalletDeclinedError('wallet_not_active', 'wallet is not active', fresh.balance);
          }
          throw new WalletDeclinedError('insufficient_balance', 'insufficient balance', fresh.balance);
        }

        await LedgerService.post({
          eventId,
          postings: [
            { account: { type: LedgerAccountType.WALLET, ref: walletId }, delta: amount },
            { account: { type: LedgerAccountType.FLOAT }, delta: -amount, tag: floatTag },
          ],
          refType: 'wallet_withdrawal',
          refId: clientTxnId,
          session,
        });

        const [withdrawal] = await WalletWithdrawal.create(
          [{ walletId, eventId, amount, method, status: 'completed', recordedBy, recordedByType, clientTxnId }],
          { session },
        );
        if (!withdrawal) throw new Error('wallet withdrawal insert failed');

        out = { wallet, withdrawal };
      });
      return out;
    } catch (e) {
      // Concurrent duplicate: the {walletId, clientTxnId} unique index lost the
      // race — re-read the winner with the SAME scoped filter.
      if ((e as { code?: number })?.code === 11000) {
        const withdrawal = await WalletWithdrawal.findOne({ walletId, clientTxnId });
        const wallet = withdrawal ? await Wallet.findById(withdrawal.walletId) : null;
        if (withdrawal && wallet) {
          assertReplayMatches(withdrawal.amount, amount);
          return { wallet, withdrawal };
        }
      }
      throw e;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Gate-side read: resolve a tapped band's wallet (cashless spec §5.1/§5.3) —
   * balance, cash-funded portion, status, and its 10 most recent top-ups.
   * Scoped to one event (a band UID is only unique per event, per the
   * {eventId, bandUid} partial index on Wallet), so callers must always pass
   * the event the band was tapped at. Returns null for an unbound/unknown uid
   * rather than throwing, so the controller can turn that into a clean 404.
   */
  static async getWalletViewByBand(bandUid: string, eventId: string) {
    const wallet = await Wallet.findOne({ eventId, bandUid });
    if (!wallet) return null;
    // A true statement: top-ups (money in), withdrawals (cash out), and vendor
    // charges (spend) merged and time-sorted, so the balance-check and receipt
    // screens can show how the current balance was arrived at.
    const [topups, withdrawals, charges] = await Promise.all([
      WalletTopup.find({ walletId: wallet._id }).sort({ createdAt: -1 }).limit(10).lean(),
      WalletWithdrawal.find({ walletId: wallet._id }).sort({ createdAt: -1 }).limit(10).lean(),
      MerchantCharge.find({ walletId: wallet._id }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    const history = [
      ...topups.map(h => ({ type: 'topup' as const, amount: h.amount, at: h.createdAt })),
      ...withdrawals.map(h => ({ type: 'withdrawal' as const, amount: h.amount, at: h.createdAt })),
      ...charges.map(h => ({ type: 'purchase' as const, amount: h.amount, at: h.createdAt })),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 15);
    return {
      // null for a standalone tag — String(undefined) would have shipped the
      // literal "undefined" to the POS as a ticket id.
      ticket: wallet.ticketId ? { id: String(wallet.ticketId) } : null,
      balance: wallet.balance, cashFundedBalance: wallet.cashFundedBalance, status: wallet.status,
      history,
    };
  }
}
