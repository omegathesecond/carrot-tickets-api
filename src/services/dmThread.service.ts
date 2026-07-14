import mongoose from 'mongoose';
import { DmThread, IDmThread } from '@models/dmThread.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Membership } from '@models/membership.model';
import { Message } from '@models/message.model';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { consumeToken } from '@utils/rateLimit.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import type { SocialActor } from '@utils/socialActor.util';

const HEX24 = /^[0-9a-f]{24}$/i;

/** The organizer brand party of a brand↔buyer thread (never the phone/email). */
export interface OrganizerSummary { id: string; businessName: string; logoUrl: string | null }

export interface DmThreadView {
  id: string;
  isGroup: boolean;
  participants: BuyerSummary[]; // the OTHER buyer participants
  organizer?: OrganizerSummary | null; // set when the thread's other party is a brand
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
    assertNotSuspended(creator);
    const creatorId = String(creator._id);
    // Lowercase before dedupe/pairKey: HEX24 accepts mixed case, but pairKey
    // dedupe and Mongo's unique index are case-sensitive.
    const otherIds = [...new Set(participantIds.map((id) => String(id).toLowerCase()))].filter(
      (id) => id !== creatorId
    );
    if (otherIds.length < 1 || otherIds.length > 9) {
      throw new HttpError(400, 'A conversation needs 1-9 other people');
    }

    // Groups never dedupe, so thread creation must be rate limited — the
    // same per-buyer budget as message sends.
    if (!consumeToken(`msg:${creatorId}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
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

  /**
   * Brand-initiated 1:1 with a buyer. The buyer stays in `participants`, so
   * they see + reply to the thread through the unchanged buyer DM path;
   * `vendorParticipantId` marks the brand side. Deduped by `vendorPairKey`.
   */
  static async openVendorThread(vendorId: string, buyerId: string): Promise<IDmThread> {
    const bid = String(buyerId).toLowerCase();
    if (!HEX24.test(bid)) throw new HttpError(400, 'Invalid participant id');
    const buyer = await Buyer.findById(bid);
    if (!buyer) throw new HttpError(404, 'User not found');
    if (!consumeToken(`msg:v:${vendorId}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
    }
    const vendorPairKey = `v:${vendorId}:${bid}`;
    const existing = await DmThread.findOne({ vendorPairKey });
    if (existing) return existing;
    try {
      return await DmThread.create({
        participants: [buyer._id],
        vendorParticipantId: new mongoose.Types.ObjectId(vendorId),
        isGroup: false,
        createdBy: buyer._id, // the buyer party (createdBy ref is Buyer)
        vendorPairKey,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        const winner = await DmThread.findOne({ vendorPairKey });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** 404 on unknown/malformed/non-participant — never leak thread existence.
   *  Actor-aware: a buyer must be in `participants`; a vendor must be the
   *  thread's `vendorParticipantId`. */
  static async requireDmAccess(threadId: string, actor: SocialActor): Promise<IDmThread> {
    if (!HEX24.test(threadId)) throw new HttpError(404, 'Conversation not found');
    const thread = await DmThread.findById(threadId);
    if (!thread) throw new HttpError(404, 'Conversation not found');
    const isMember =
      actor.type === 'buyer'
        ? thread.participants.some((p) => String(p) === actor.id)
        : String(thread.vendorParticipantId ?? '') === actor.id;
    if (!isMember) throw new HttpError(404, 'Conversation not found');
    return thread;
  }

  static async buildThreadView(thread: IDmThread, actor: SocialActor): Promise<DmThreadView> {
    // For a buyer viewer, "others" are the other buyers; for a vendor viewer,
    // the buyer participants. A buyer viewing a brand thread also sees the
    // brand as `organizer`.
    const otherBuyerIds = thread.participants.filter((p) => actor.type !== 'buyer' || String(p) !== actor.id);
    const others = await Buyer.find({ _id: { $in: otherBuyerIds } });
    let organizer: OrganizerSummary | null = null;
    if (actor.type === 'buyer' && thread.vendorParticipantId) {
      const v = await Vendor.findById(thread.vendorParticipantId).select('businessName logoUrl');
      if (v) organizer = { id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null };
    }
    const since = thread.readState.get(actor.id) ?? thread.createdAt;
    const notMine =
      actor.type === 'buyer'
        ? { senderId: { $ne: new mongoose.Types.ObjectId(actor.id) } }
        : { senderVendorId: { $ne: new mongoose.Types.ObjectId(actor.id) } };
    const unreadCount = await Message.countDocuments(
      { dmThreadId: thread._id, createdAt: { $gt: since }, ...notMine },
      { limit: 99 }
    );
    return {
      id: String(thread._id),
      isGroup: thread.isGroup,
      participants: others.map(toBuyerSummary),
      organizer,
      lastMessageAt: thread.lastMessageAt ?? null,
      unreadCount,
    };
  }

  static async listThreads(actor: SocialActor): Promise<DmThreadView[]> {
    const query =
      actor.type === 'buyer'
        ? { participants: new mongoose.Types.ObjectId(actor.id) }
        : { vendorParticipantId: new mongoose.Types.ObjectId(actor.id) };
    const threads = await DmThread.find(query).sort({ lastMessageAt: -1 }).limit(50);
    return Promise.all(threads.map((t) => DmThreadService.buildThreadView(t, actor)));
  }
}
