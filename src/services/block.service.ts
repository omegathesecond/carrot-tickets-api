import { Block } from '@models/block.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { HttpError } from '@utils/httpError.util';

export class BlockService {
  /** Actor-agnostic core: blocks are keyed on ids only, so a buyer↔buyer,
   *  buyer↔brand, or brand↔buyer block all share one enforcement path. The
   *  target may be a buyer OR a vendor brand. */
  static async blockActor(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) throw new HttpError(400, 'You cannot block yourself');
    const exists = (await Buyer.exists({ _id: blockedId })) || (await Vendor.exists({ _id: blockedId }));
    if (!exists) throw new HttpError(404, 'User not found');
    try {
      await Block.create({ blockerId, blockedId });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // already blocked — idempotent
    }
  }

  static async unblockActor(blockerId: string, blockedId: string): Promise<void> {
    await Block.deleteOne({ blockerId, blockedId });
  }

  static async block(buyer: IBuyer, targetUserId: string): Promise<void> {
    return BlockService.blockActor(String(buyer._id), targetUserId);
  }

  static async unblock(buyer: IBuyer, targetUserId: string): Promise<void> {
    return BlockService.unblockActor(String(buyer._id), targetUserId);
  }

  static async blockAsVendor(vendorId: string, targetId: string): Promise<void> {
    return BlockService.blockActor(String(vendorId), targetId);
  }

  static async unblockAsVendor(vendorId: string, targetId: string): Promise<void> {
    return BlockService.unblockActor(String(vendorId), targetId);
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
