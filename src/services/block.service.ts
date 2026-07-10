import { Block } from '@models/block.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { HttpError } from '@utils/httpError.util';

export class BlockService {
  static async block(buyer: IBuyer, targetUserId: string): Promise<void> {
    if (String(buyer._id) === targetUserId) throw new HttpError(400, 'You cannot block yourself');
    const exists = await Buyer.exists({ _id: targetUserId });
    if (!exists) throw new HttpError(404, 'User not found');
    try {
      await Block.create({ blockerId: buyer._id, blockedId: targetUserId });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // already blocked — idempotent
    }
  }

  static async unblock(buyer: IBuyer, targetUserId: string): Promise<void> {
    await Block.deleteOne({ blockerId: buyer._id, blockedId: targetUserId });
  }

  static async listBlockedIds(buyerId: string): Promise<string[]> {
    const rows = await Block.find({ blockerId: buyerId }).select('blockedId');
    return rows.map((r) => String(r.blockedId));
  }

  /** Buyers who have blocked this buyer (reverse direction). */
  static async listBlockerIds(buyerId: string): Promise<string[]> {
    const rows = await Block.find({ blockedId: buyerId }).select('blockerId');
    return rows.map((r) => String(r.blockerId));
  }

  static async isBlockedEitherWay(buyerIdA: string, buyerIdB: string): Promise<boolean> {
    const hit = await Block.exists({
      $or: [
        { blockerId: buyerIdA, blockedId: buyerIdB },
        { blockerId: buyerIdB, blockedId: buyerIdA },
      ],
    });
    return hit !== null;
  }
}
