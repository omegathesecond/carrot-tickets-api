import mongoose, { ClientSession } from 'mongoose';
import { LedgerEntry } from '@models/ledgerEntry.model';
import {
  LedgerAccount,
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
  /** Supply to make the write idempotent against a known id; otherwise generated. */
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
      sum += p.delta;
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
}
