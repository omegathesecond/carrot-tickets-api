import mongoose from 'mongoose';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';

export interface TagSummary {
  tagsInUse: number;
  activeTags: number;
  unboundTags: number;
  balanceOutstanding: number;
  cashFundedOutstanding: number;
  averageBalance: number;
}

export type TagStatus = 'active' | 'unbound' | 'frozen' | 'closed';

export interface TagRow {
  walletId: string;
  bandUid: string | null;
  status: TagStatus;
  balance: number;
  cashFundedBalance: number;
  holder: { name: string | null; phone: string | null; ticketCode: string | null };
}

/**
 * Status is derived: the plastic and the wallet each tell half the story. A
 * lost tag leaves an ACTIVE wallet holding money with no band on it, which is
 * not a state `wallet.status` can express on its own.
 */
const statusStage = {
  $switch: {
    branches: [
      { case: { $in: ['$status', ['frozen', 'closed']] }, then: '$status' },
      { case: { $eq: ['$bandUid', null] }, then: 'unbound' },
    ],
    default: 'active',
  },
};

/**
 * Read-only aggregations behind the organizer's Tags screen. A "tag" here is a
 * Wallet: the plastic carries only a UID, the wallet carries the money and the
 * continuity across a lost-tag reissue.
 */
export class TagReportService {
  static async summary(eventId: string): Promise<TagSummary> {
    const [row] = await Wallet.aggregate([
      { $match: { eventId: new mongoose.Types.ObjectId(eventId) } },
      {
        $group: {
          _id: null,
          tagsInUse: { $sum: 1 },
          // A deactivated tag leaves the wallet active with a null bandUid —
          // the money is still owed, so it must not drop out of the totals.
          activeTags: {
            $sum: { $cond: [{ $and: [{ $ne: ['$bandUid', null] }, { $eq: ['$status', 'active'] }] }, 1, 0] },
          },
          unboundTags: {
            $sum: { $cond: [{ $and: [{ $eq: ['$bandUid', null] }, { $eq: ['$status', 'active'] }] }, 1, 0] },
          },
          balanceOutstanding: { $sum: '$balance' },
          cashFundedOutstanding: { $sum: '$cashFundedBalance' },
        },
      },
    ]);

    const tagsInUse = row?.tagsInUse ?? 0;
    return {
      tagsInUse,
      activeTags: row?.activeTags ?? 0,
      unboundTags: row?.unboundTags ?? 0,
      balanceOutstanding: row?.balanceOutstanding ?? 0,
      cashFundedOutstanding: row?.cashFundedOutstanding ?? 0,
      // Integer cents: an average that is not a whole cent is rounded, never floated.
      averageBalance: tagsInUse ? Math.round((row?.balanceOutstanding ?? 0) / tagsInUse) : 0,
    };
  }

  static async list(
    eventId: string,
    opts: { limit?: number; cursor?: string; status?: TagStatus; q?: string },
  ): Promise<{ tags: TagRow[]; hasMore: boolean; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const match: Record<string, unknown> = { eventId: new mongoose.Types.ObjectId(eventId) };
    // _id desc + a strictly-less-than cursor: the same convention as the stock
    // movements feed, so a row can neither repeat nor be skipped at a boundary.
    if (opts.cursor) match['_id'] = { $lt: new mongoose.Types.ObjectId(opts.cursor) };

    const pipeline: any[] = [
      { $match: match },
      { $sort: { _id: -1 } },
      { $lookup: { from: Ticket.collection.name, localField: 'ticketId', foreignField: '_id', as: 'ticket' } },
      { $unwind: { path: '$ticket', preserveNullAndEmptyArrays: true } },
      { $addFields: { tagStatus: statusStage } },
    ];

    if (opts.status) pipeline.push({ $match: { tagStatus: opts.status } });

    if (opts.q) {
      // Escaped: a UID or a name is user input, and an unescaped regex here is
      // both a correctness bug and a ReDoS foothold.
      const safe = opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      pipeline.push({
        $match: { $or: [{ bandUid: rx }, { 'ticket.customerName': rx }, { 'ticket.customerPhone': rx }] },
      });
    }

    pipeline.push({ $limit: limit + 1 });

    const rows = await Wallet.aggregate(pipeline);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      tags: page.map((r: any) => ({
        walletId: String(r._id),
        bandUid: r.bandUid ?? null,
        status: r.tagStatus as TagStatus,
        balance: r.balance,
        cashFundedBalance: r.cashFundedBalance,
        holder: {
          name: r.ticket?.customerName ?? null,
          phone: r.ticket?.customerPhone ?? null,
          ticketCode: r.ticket?.ticketId ?? null,
        },
      })),
      hasMore,
      nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
    };
  }
}
