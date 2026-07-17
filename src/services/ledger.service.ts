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
      if (!accountRequiresRef(p.account.type) && p.account.ref) {
        throw new Error(`${p.account.type} account does not take a ref`);
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
   * Signed balance of one account: Σ delta.
   * Asset (float) → positive when holding money.
   * Liability/revenue (wallet/merchant/fees) → negative when owed/earned.
   */
  static async accountBalance(eventId: string, account: LedgerAccount): Promise<number> {
    if (accountRequiresRef(account.type) && !account.ref) {
      throw new Error(`${account.type} account requires a ref`);
    }
    const [row] = await LedgerEntry.aggregate<{ total: number }>([
      {
        $match: {
          eventId: new mongoose.Types.ObjectId(eventId),
          accountType: account.type,
          accountRef: account.ref ?? null,
        },
      },
      { $group: { _id: null, total: { $sum: '$delta' } } },
    ]);
    return row?.total ?? 0;
  }

  /** Signed float balance, optionally restricted to money sitting in one place. */
  static async floatBalance(eventId: string, tag?: FloatTag): Promise<number> {
    const [row] = await LedgerEntry.aggregate<{ total: number }>([
      {
        $match: {
          eventId: new mongoose.Types.ObjectId(eventId),
          accountType: LedgerAccountType.FLOAT,
          ...(tag ? { tag } : {}),
        },
      },
      { $group: { _id: null, total: { $sum: '$delta' } } },
    ]);
    return row?.total ?? 0;
  }

  /**
   * Human-facing positive figure for a credit-normal account type:
   * total owed (wallet/merchant) or earned (fees) across the event.
   */
  static async totalOwed(eventId: string, type: LedgerAccountType): Promise<number> {
    const [row] = await LedgerEntry.aggregate<{ total: number }>([
      {
        $match: { eventId: new mongoose.Types.ObjectId(eventId), accountType: type },
      },
      { $group: { _id: null, total: { $sum: '$delta' } } },
    ]);
    return -(row?.total ?? 0);
  }
}
