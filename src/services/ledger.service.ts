import mongoose, { ClientSession } from 'mongoose';
import { LedgerEntry } from '@models/ledgerEntry.model';
import {
  LedgerAccount,
  LedgerAccountType,
  FloatTag,
  accountRequiresRef,
} from '@interfaces/ledger.interface';
import { randomUUID } from 'crypto';

export interface Posting {
  account: LedgerAccount;
  /** Signed amount in ZAR cents. > 0 debit, < 0 credit. */
  delta: number;
  tag?: FloatTag;
}

export interface PostInput {
  eventId: string | mongoose.Types.ObjectId;
  postings: Posting[];
  refType: string;
  refId: string;
  /**
   * Correlation/tracing id shared by every leg of this transaction. Generated
   * when omitted.
   *
   * post() is NOT idempotent. Calling it twice with the same txnId writes the
   * legs twice, and because each set balances on its own the sum-to-zero
   * invariant will NOT catch the duplicate. Callers needing exactly-once must
   * guarantee it at their own layer — a status CAS on their own record (e.g.
   * BookingSale.paymentStatus) — before calling post().
   */
  txnId?: string;
  /** Join an existing transaction (e.g. a wallet debit + its postings). */
  session?: ClientSession;
}

/**
 * The ONLY writer of LedgerEntry (spec §3).
 *
 * Every call must supply postings that sum to exactly zero under the
 * debit-positive convention. An unbalanced set is a programming error and
 * throws — it is never silently corrected, because a silently-corrected
 * ledger is a ledger you cannot trust.
 */
export class LedgerService {
  static async post(input: PostInput): Promise<string> {
    const { postings, refType, refId } = input;

    if (!postings || postings.length < 2) {
      throw new Error('a transaction needs at least 2 postings');
    }

    let sum = 0;
    for (const p of postings) {
      if (!Number.isSafeInteger(p.delta)) {
        throw new Error(`delta must be integer minor units (ZAR cents), got ${p.delta}`);
      }
      if (accountRequiresRef(p.account.type) && !p.account.ref) {
        throw new Error(`${p.account.type} account requires a ref`);
      }
      // A ref on a singleton account (FLOAT/FEES) would persist accountRef and
      // split the bucket under the {eventId, accountType, accountRef} grouping
      // balances are derived from — a phantom account.
      // `!= null` (not truthiness) so an empty-string ref is rejected rather than
      // persisted: accountRef '' is invisible to accountBalance()'s `accountRef:
      // null` match, so a ''-ref FLOAT leg would silently under-report the float.
      // The write guard must be at least as strict as the read guard.
      if (!accountRequiresRef(p.account.type) && p.account.ref != null) {
        throw new Error(`${p.account.type} account does not take a ref`);
      }
      // A FLOAT leg with no tag is money attributable to no physical location:
      // counted by floatBalance() but by NEITHER floatBalance(KESHLESS) NOR
      // floatBalance(CASH_DESK), while checkInvariant still reports ok. That
      // silently defeats external reconciliation (ledger float vs actual Keshless
      // balance + cash on hand) — the only check that catches real-world loss.
      if (p.account.type === LedgerAccountType.FLOAT && p.tag == null) {
        throw new Error('float posting requires a tag');
      }
      // tag is meaningful ONLY on FLOAT (see FloatTag). A tag elsewhere is a
      // caller confusion; persisting it would make `{accountType: FLOAT, tag}`
      // reads look correct while the tag documents nothing.
      if (p.account.type !== LedgerAccountType.FLOAT && p.tag != null) {
        throw new Error(`${p.account.type} posting does not take a tag`);
      }
      sum += p.delta;
    }
    if (!Number.isSafeInteger(sum)) {
      throw new Error(`transaction sum ${sum} is outside the safe integer range`);
    }
    if (sum !== 0) {
      throw new Error(`unbalanced transaction: postings sum to ${sum}, expected 0`);
    }

    const txnId = input.txnId ?? randomUUID();
    const eventId =
      typeof input.eventId === 'string'
        ? new mongoose.Types.ObjectId(input.eventId)
        : input.eventId;

    const docs = postings.map((p) => ({
      eventId,
      txnId,
      accountType: p.account.type,
      accountRef: p.account.ref ?? null,
      delta: p.delta,
      ...(p.tag ? { tag: p.tag } : {}),
      refType,
      refId,
    }));

    if (input.session) {
      // Caller owns the transaction (e.g. wallet debit + postings together).
      // A session that is NOT in a transaction gives a plain insertMany, where
      // an ordered mid-array failure commits the earlier legs — the half-written
      // post this function exists to prevent. Refuse rather than pretend.
      if (!input.session.inTransaction()) {
        throw new Error('post() requires the caller session to be in a transaction');
      }
      await LedgerEntry.insertMany(docs, { session: input.session });
      return txnId;
    }

    // No caller session: own the atomicity ourselves so a multi-leg post can
    // never land half-written.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await LedgerEntry.insertMany(docs, { session });
      });
    } finally {
      await session.endSession();
    }
    return txnId;
  }

  /**
   * Σ delta over the matched postings, or 0 when nothing matches.
   *
   * The single aggregation every balance read is derived from — keeping the
   * pipeline in one place is what makes "no postings" mean 0 consistently
   * rather than three near-identical hand-rolls drifting apart.
   */
  private static async sumDeltas(
    match: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<number> {
    const [row] = await LedgerEntry.aggregate<{ total: number }>([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$delta' } } },
    ]).session(session ?? null);
    return row?.total ?? 0;
  }

  /**
   * Signed balance of one account: Σ delta.
   * Asset (float) → positive when holding money.
   * Liability/revenue (wallet/merchant/fees) → negative when owed/earned.
   *
   * NOT A SAFE BASIS FOR ENFORCING A NON-NEGATIVE BALANCE. See the overdraft
   * note on floatBalance() below; it applies to every read on this service,
   * `session` or no `session`.
   */
  static async accountBalance(
    eventId: string,
    account: LedgerAccount,
    session?: ClientSession,
  ): Promise<number> {
    const requiresRef = accountRequiresRef(account.type);
    if (requiresRef && !account.ref) {
      throw new Error(`${account.type} account requires a ref`);
    }
    // Mirror of post()'s phantom-account guard. A ref on a singleton account
    // matches accountRef: '<ref>', finds nothing and would report the float as
    // empty when it is not — the read side must refuse what the write side does.
    // `!= null` (not truthiness) so an empty-string ref counts as supplied.
    if (!requiresRef && account.ref != null) {
      throw new Error(`${account.type} account does not take a ref`);
    }
    return this.sumDeltas(
      {
        eventId: new mongoose.Types.ObjectId(eventId),
        accountType: account.type,
        accountRef: account.ref ?? null,
      },
      session,
    );
  }

  /**
   * Signed float balance, optionally restricted to money sitting in one place.
   *
   * NOT A SAFE BASIS FOR ENFORCING A NON-NEGATIVE BALANCE — this applies to
   * accountBalance() and totalOwed() equally.
   *
   * Passing `session` lets a read join a caller's transaction, but a read can
   * never exclude a concurrent writer, so read-then-post is a TOCTOU race:
   * two concurrent taps each read 5000, each post -5000, both commit, and the
   * wallet goes to -5000 — money created out of nothing. Snapshot isolation
   * does not save you either: each transaction reads a snapshot taken before
   * the other wrote, and neither conflicts on a document it only appended
   * beside.
   *
   * Overdraft prevention MUST come from an atomic compare-and-swap on a stored
   * balance, where the guard and the decrement are the same operation:
   *
   *   findOneAndUpdate({ _id, balance: { $gte: amount } },
   *                    { $inc: { balance: -amount } })
   *
   * A null result means insufficient funds — reject the tap and post nothing.
   * These reads are for reporting and reconciliation, never for authorization.
   */
  static async floatBalance(
    eventId: string,
    tag?: FloatTag,
    session?: ClientSession,
  ): Promise<number> {
    return this.sumDeltas(
      {
        eventId: new mongoose.Types.ObjectId(eventId),
        accountType: LedgerAccountType.FLOAT,
        ...(tag ? { tag } : {}),
      },
      session,
    );
  }

  /**
   * Human-facing positive figure for a credit-normal account type:
   * total owed (wallet/merchant) or earned (fees) across the event.
   *
   * NOT A SAFE BASIS FOR ENFORCING A NON-NEGATIVE BALANCE. See the overdraft
   * note on floatBalance().
   */
  static async totalOwed(
    eventId: string,
    type: LedgerAccountType,
    session?: ClientSession,
  ): Promise<number> {
    // FLOAT is debit-normal; negating it yields a nonsense "owed" asset.
    if (type === LedgerAccountType.FLOAT) {
      throw new Error(
        `totalOwed is for credit-normal accounts; ${type} is an asset — use floatBalance()`,
      );
    }
    const total = await this.sumDeltas(
      {
        eventId: new mongoose.Types.ObjectId(eventId),
        accountType: type,
      },
      session,
    );
    // `0 - total`, not `-total`: negating 0 gives -0, which Object.is (and so
    // Jest's toBe) distinguishes from 0.
    return 0 - total;
  }
}
