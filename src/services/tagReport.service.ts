import mongoose from 'mongoose';
import { Wallet } from '@models/wallet.model';

export interface TagSummary {
  tagsInUse: number;
  activeTags: number;
  unboundTags: number;
  balanceOutstanding: number;
  cashFundedOutstanding: number;
  averageBalance: number;
}

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
}
