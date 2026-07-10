import mongoose from 'mongoose';
import { DmThread, IDmThread } from '@models/dmThread.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { Message } from '@models/message.model';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';

const HEX24 = /^[0-9a-f]{24}$/i;

export interface DmThreadView {
  id: string;
  isGroup: boolean;
  participants: BuyerSummary[]; // the OTHER participants
  lastMessageAt: Date | null;
  unreadCount: number;
}

export class DmThreadService {
  static pairKeyFor(idA: string, idB: string): string {
    const [lo, hi] = [idA, idB].sort();
    return `${lo}:${hi}`;
  }

  /**
   * The spec's DM privacy gate (§2.4). Order matters: block beats everything,
   * then the target's own privacy setting decides.
   */
  static async assertCanDm(sender: IBuyer, target: IBuyer): Promise<void> {
    const senderId = String(sender._id);
    const targetId = String(target._id);

    if (await BlockService.isBlockedEitherWay(senderId, targetId)) {
      throw new HttpError(403, 'You cannot message this user');
    }

    const friends = await FollowService.isFriend(senderId, targetId);
    if (target.dmPrivacy === 'friends') {
      if (!friends) throw new HttpError(403, 'This user only accepts messages from friends');
      return;
    }

    // 'community' (default): friends OR any shared community.
    if (friends) return;
    const myCommunities = await Membership.find({ buyerId: sender._id, bannedAt: { $exists: false } }).select('communityId');
    const shared = await Membership.exists({
      buyerId: target._id,
      bannedAt: { $exists: false },
      communityId: { $in: myCommunities.map((m) => m.communityId) },
    });
    if (!shared) throw new HttpError(403, 'You can only message people you share a community with');
  }

  static async openThread(creator: IBuyer, participantIds: string[]): Promise<IDmThread> {
    const creatorId = String(creator._id);
    // Lowercase before dedupe/pairKey: HEX24 accepts mixed case, but pairKey
    // dedupe and Mongo's unique index are case-sensitive.
    const otherIds = [...new Set(participantIds.map((id) => String(id).toLowerCase()))].filter(
      (id) => id !== creatorId
    );
    if (otherIds.length < 1 || otherIds.length > 9) {
      throw new HttpError(400, 'A conversation needs 1-9 other people');
    }
    if (!otherIds.every((id) => HEX24.test(id))) {
      throw new HttpError(400, 'Invalid participant id');
    }

    const others = await Buyer.find({ _id: { $in: otherIds } });
    if (others.length !== otherIds.length) throw new HttpError(404, 'User not found');
    for (const other of others) {
      await DmThreadService.assertCanDm(creator, other);
    }

    if (otherIds.length === 1) {
      const pairKey = DmThreadService.pairKeyFor(creatorId, otherIds[0]!);
      const existing = await DmThread.findOne({ pairKey });
      if (existing) return existing;
      try {
        return await DmThread.create({
          participants: [creator._id, new mongoose.Types.ObjectId(otherIds[0]!)],
          isGroup: false,
          createdBy: creator._id,
          pairKey,
        });
      } catch (err: any) {
        if (err?.code === 11000) {
          const winner = await DmThread.findOne({ pairKey });
          if (winner) return winner;
        }
        throw err;
      }
    }

    return DmThread.create({
      participants: [creator._id, ...otherIds.map((id) => new mongoose.Types.ObjectId(id))],
      isGroup: true,
      createdBy: creator._id,
    });
  }

  /** 404 on unknown/malformed/non-participant — never leak thread existence. */
  static async requireDmAccess(threadId: string, buyer: IBuyer): Promise<IDmThread> {
    if (!HEX24.test(threadId)) throw new HttpError(404, 'Conversation not found');
    const thread = await DmThread.findById(threadId);
    if (!thread) throw new HttpError(404, 'Conversation not found');
    const me = String(buyer._id);
    if (!thread.participants.some((p) => String(p) === me)) {
      throw new HttpError(404, 'Conversation not found');
    }
    return thread;
  }

  static async buildThreadView(thread: IDmThread, buyer: IBuyer): Promise<DmThreadView> {
    const me = String(buyer._id);
    const otherIds = thread.participants.filter((p) => String(p) !== me);
    const others = await Buyer.find({ _id: { $in: otherIds } });
    const since = thread.readState.get(me) ?? thread.createdAt;
    const unreadCount = await Message.countDocuments(
      { dmThreadId: thread._id, createdAt: { $gt: since }, senderId: { $ne: buyer._id } },
      { limit: 99 }
    );
    return {
      id: String(thread._id),
      isGroup: thread.isGroup,
      participants: others.map(toBuyerSummary),
      lastMessageAt: thread.lastMessageAt ?? null,
      unreadCount,
    };
  }

  static async listThreads(buyer: IBuyer): Promise<DmThreadView[]> {
    const threads = await DmThread.find({ participants: buyer._id })
      .sort({ lastMessageAt: -1 })
      .limit(50);
    return Promise.all(threads.map((t) => DmThreadService.buildThreadView(t, buyer)));
  }
}
