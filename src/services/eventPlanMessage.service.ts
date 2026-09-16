import { EventPlanMessage, IEventPlanMessage } from '@models/eventPlanMessage.model';
import { EventPlanMessageReaction, PLAN_MESSAGE_REACTIONS, PlanMessageReactionEmoji } from '@models/eventPlanMessageReaction.model';
import { EventPlanMember } from '@models/eventPlanMember.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { EventPlanService } from '@services/eventPlan.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { updatesR2 } from '@utils/updatesR2';
import { triggerTranscode } from '@services/transcode.client';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import type { UpdateKind } from '@interfaces/update.interface';

const displayName = (b: IBuyer): string => b.username ?? b.name ?? 'Someone';

const MAX_MEDIA_ITEMS = 5;

export class EventPlanMessageService {
  /** Public plans: readable by anyone who can view the plan (spec §9 — "Public
   *  visitors may read... but cannot participate until they join"). Private
   *  plans: readable only by accepted members/admin, same as everything else. */
  static async list(planId: string, viewerId: string | null, before?: string, limit = 30): Promise<any[]> {
    const plan = await EventPlanService.loadForAccess(planId);
    const { canView } = await EventPlanService.accessFor(plan, viewerId);
    if (!canView) throw new HttpError(404, 'Plan not found');

    const filter: any = { planId, deletedAt: { $exists: false } };
    if (before) {
      if (!HEX24.test(before)) throw new HttpError(400, 'Invalid cursor');
      filter._id = { $lt: before };
    }
    const rows = await EventPlanMessage.find(filter)
      .sort({ _id: -1 })
      .limit(Math.min(Math.max(limit, 1), 100));

    return EventPlanMessageService.hydrate(rows.reverse());
  }

  private static async hydrate(rows: IEventPlanMessage[]): Promise<any[]> {
    if (rows.length === 0) return [];
    const senderIds = [...new Set(rows.map((r) => String(r.senderId)))];
    const senders = await Buyer.find({ _id: { $in: senderIds } }).select('name username avatarUrl');
    const senderById = new Map(senders.map((b: any) => [String(b._id), b]));

    const reactions = await EventPlanMessageReaction.find({ messageId: { $in: rows.map((r) => r._id) } });
    const reactionsByMessage = new Map<string, { emoji: string; buyerId: string }[]>();
    for (const r of reactions) {
      const key = String(r.messageId);
      const list = reactionsByMessage.get(key) ?? [];
      list.push({ emoji: r.emoji, buyerId: String(r.buyerId) });
      reactionsByMessage.set(key, list);
    }

    return rows.map((r) => {
      const sender = senderById.get(String(r.senderId));
      return {
        id: String(r._id),
        kind: r.kind,
        body: r.body,
        media: r.media ?? [],
        replyTo: r.replyTo ? String(r.replyTo) : null,
        sender: sender
          ? { id: String(sender._id), name: sender.name ?? null, username: sender.username ?? null, avatarUrl: sender.avatarUrl ?? null }
          : null,
        reactions: EventPlanMessageService.groupReactions(reactionsByMessage.get(String(r._id)) ?? []),
        editedAt: r.editedAt ?? null,
        createdAt: r.createdAt,
      };
    });
  }

  private static groupReactions(list: { emoji: string; buyerId: string }[]) {
    const byEmoji = new Map<string, string[]>();
    for (const { emoji, buyerId } of list) {
      const arr = byEmoji.get(emoji) ?? [];
      arr.push(buyerId);
      byEmoji.set(emoji, arr);
    }
    return [...byEmoji.entries()].map(([emoji, buyerIds]) => ({ emoji, count: buyerIds.length, buyerIds }));
  }

  static async send(sender: IBuyer, planId: string, body: string, replyTo?: string): Promise<any> {
    const plan = await EventPlanService.loadForAccess(planId);
    const senderId = String(sender._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, senderId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to send messages');
    if (plan.status !== 'active') throw new HttpError(409, 'This plan is closed');

    const trimmed = (body || '').trim();
    if (!trimmed) throw new HttpError(400, 'Message cannot be empty');
    if (trimmed.length > 2000) throw new HttpError(400, 'Message is too long');
    if (replyTo && !HEX24.test(replyTo)) throw new HttpError(400, 'Invalid reply target');
    if (replyTo && !(await EventPlanMessage.exists({ _id: replyTo, planId }))) {
      throw new HttpError(404, 'The message you are replying to was not found');
    }

    const message = await EventPlanMessage.create({ planId, senderId: sender._id, body: trimmed, replyTo: replyTo || undefined });

    const memberIds = await EventPlanMessageService.otherAcceptedMemberIds(planId, senderId);
    if (memberIds.length > 0) {
      NotificationDispatcher.dispatchAsync(
        memberIds,
        'plan_message',
        displayName(sender),
        trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed,
        { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined, messageId: String(message._id) },
        senderId
      );
    }

    return (await EventPlanMessageService.hydrate([message]))[0];
  }

  private static async otherAcceptedMemberIds(planId: string, excludeId: string): Promise<string[]> {
    const rows = await EventPlanMember.find({ planId, status: 'accepted' }).select('buyerId');
    return rows.map((r) => String(r.buyerId)).filter((id) => id !== excludeId);
  }

  /**
   * Create a photo/video post (spec §6). Two-step, mirroring Update's
   * upload flow exactly (@services/update.service#createUpdate): this
   * returns presigned PUT urls for the client to upload each file to
   * directly, then the client calls finalizePost once every upload
   * succeeds. Nothing here downloads or touches the file bytes.
   *
   * `clientToken`, if given, makes a retried create safe (spec §6 —
   * "prevent duplicate posts when a submission is retried"): a second call
   * with the same token from the same sender in the same plan returns the
   * original post instead of creating a second one, via the model's unique
   * partial index rather than a read-then-write race.
   */
  static async createPost(
    sender: IBuyer,
    planId: string,
    input: { kind: UpdateKind; body?: string; replyTo?: string; items: { ext: string; contentType: string }[]; clientToken?: string }
  ): Promise<{ message: any; uploads: { index: number; uploadUrl: string }[] }> {
    const plan = await EventPlanService.loadForAccess(planId);
    const senderId = String(sender._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, senderId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to post');
    if (plan.status !== 'active') throw new HttpError(409, 'This plan is closed');

    if (input.clientToken) {
      const existing = await EventPlanMessage.findOne({ planId, senderId, clientToken: input.clientToken });
      if (existing) return { message: (await EventPlanMessageService.hydrate([existing]))[0], uploads: [] };
    }

    if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(400, 'At least one photo or video is required');
    const maxItems = input.kind === 'video' ? 1 : MAX_MEDIA_ITEMS;
    if (input.items.length > maxItems) throw new HttpError(400, `A ${input.kind} post supports at most ${maxItems} file(s)`);

    const body = (input.body || '').trim();
    if (body.length > 2000) throw new HttpError(400, 'Caption is too long');
    if (input.replyTo && !HEX24.test(input.replyTo)) throw new HttpError(400, 'Invalid reply target');
    if (input.replyTo && !(await EventPlanMessage.exists({ _id: input.replyTo, planId }))) {
      throw new HttpError(404, 'The post you are replying to was not found');
    }

    const prepared = await Promise.all(
      input.items.map(async (it, index) => {
        const rawKey = updatesR2.rawKey(it.ext);
        const uploadUrl = await updatesR2.presignPut(rawKey, it.contentType);
        return { index, rawKey, uploadUrl };
      })
    );

    let message: IEventPlanMessage;
    try {
      message = await EventPlanMessage.create({
        planId,
        senderId: sender._id,
        kind: input.kind,
        body,
        media: prepared.map((p) => ({ rawKey: p.rawKey, status: 'processing' })),
        replyTo: input.replyTo || undefined,
        clientToken: input.clientToken || undefined,
      });
    } catch (err: any) {
      // Duplicate key on the (planId, senderId, clientToken) index = a retry
      // that raced this same call rather than a real conflict — return the
      // row the other request created instead of erroring.
      if (err?.code === 11000 && input.clientToken) {
        const existing = await EventPlanMessage.findOne({ planId, senderId, clientToken: input.clientToken });
        if (existing) return { message: (await EventPlanMessageService.hydrate([existing]))[0], uploads: [] };
      }
      throw err;
    }

    return {
      message: (await EventPlanMessageService.hydrate([message]))[0],
      uploads: prepared.map((p) => ({ index: p.index, uploadUrl: p.uploadUrl })),
    };
  }

  /** Marks every uploaded file ready (images) or kicks off transcoding
   *  (video) — mirrors @services/update.service#finalizeUpdate. Only the
   *  post's own sender may finalize it. */
  static async finalizePost(sender: IBuyer, planId: string, messageId: string): Promise<any> {
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid post id');
    const message = await EventPlanMessage.findOne({ _id: messageId, planId });
    if (!message) throw new HttpError(404, 'Post not found');
    if (String(message.senderId) !== String(sender._id)) throw new HttpError(403, 'Only the author can finalize this post');

    if (message.kind === 'image') {
      for (const item of message.media) {
        item.image = { url: updatesR2.publicUrl(item.rawKey), width: 0, height: 0 };
        item.status = 'ready';
      }
      await message.save();
    } else if (message.kind === 'video') {
      const video = message.media[0];
      if (!video) throw new HttpError(400, 'Post has no media');
      video.processingStartedAt = new Date();
      video.status = 'processing';
      await message.save();
      // fire-and-forget; durability comes from a reconcile sweep, same as Update/Story
      triggerTranscode({ id: message.id, media: message.media, collection: 'eventPlanMessages' }).catch((err) =>
        console.error('triggerTranscode (plan post) failed:', err?.message)
      );
    }

    const plan = await EventPlanService.loadForAccess(planId);
    const senderId = String(sender._id);
    const memberIds = await EventPlanMessageService.otherAcceptedMemberIds(planId, senderId);
    if (memberIds.length > 0) {
      NotificationDispatcher.dispatchAsync(
        memberIds,
        'plan_message',
        displayName(sender),
        message.body || (message.kind === 'video' ? 'shared a video' : 'shared a photo'),
        { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined, messageId: String(message._id) },
        senderId
      );
    }

    return (await EventPlanMessageService.hydrate([message]))[0];
  }

  /** Edit a post's caption after publishing (spec §6) — the author only;
   *  media itself is immutable once posted, same restriction as Update. */
  static async editCaption(buyer: IBuyer, planId: string, messageId: string, body: string): Promise<any> {
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid post id');
    const message = await EventPlanMessage.findOne({ _id: messageId, planId, deletedAt: { $exists: false } });
    if (!message) throw new HttpError(404, 'Post not found');
    if (String(message.senderId) !== String(buyer._id)) throw new HttpError(403, 'Only the author can edit this post');

    const trimmed = (body || '').trim();
    if (message.kind === 'text' && !trimmed) throw new HttpError(400, 'Message cannot be empty');
    if (trimmed.length > 2000) throw new HttpError(400, 'Message is too long');

    message.body = trimmed;
    message.editedAt = new Date();
    await message.save();
    return (await EventPlanMessageService.hydrate([message]))[0];
  }

  /** Delete a post (spec §6/§8 moderation) — the author can delete their own;
   *  the plan admin can remove anyone's (soft-delete, same as Update's
   *  status field — the row stays for audit/reaction integrity). */
  static async deletePost(buyer: IBuyer, planId: string, messageId: string): Promise<void> {
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid post id');
    const plan = await EventPlanService.loadForAccess(planId);
    const message = await EventPlanMessage.findOne({ _id: messageId, planId, deletedAt: { $exists: false } });
    if (!message) throw new HttpError(404, 'Post not found');

    const buyerId = String(buyer._id);
    const isAuthor = String(message.senderId) === buyerId;
    const isAdmin = String(plan.adminId) === buyerId;
    if (!isAuthor && !isAdmin) throw new HttpError(403, 'You can only delete your own posts');

    message.deletedAt = new Date();
    await message.save();
  }

  /** Bumps the viewer's Posts read marker to now (spec §5 — "unread-content
   *  counts"). Silent no-op for a non-member; there's nothing to mark. */
  static async markRead(buyer: IBuyer, planId: string): Promise<void> {
    await EventPlanMember.updateOne(
      { planId, buyerId: buyer._id, status: 'accepted' },
      { $set: { lastReadAt: new Date() } }
    );
  }

  static async react(buyer: IBuyer, planId: string, messageId: string, emoji: string): Promise<void> {
    const plan = await EventPlanService.loadForAccess(planId);
    const buyerId = String(buyer._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, buyerId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to react to messages');
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid message id');
    if (!PLAN_MESSAGE_REACTIONS.includes(emoji as PlanMessageReactionEmoji)) throw new HttpError(400, 'Unsupported reaction');
    const message = await EventPlanMessage.exists({ _id: messageId, planId });
    if (!message) throw new HttpError(404, 'Message not found');

    await EventPlanMessageReaction.findOneAndUpdate(
      { messageId, buyerId },
      { $set: { emoji, planId } },
      { upsert: true, new: true }
    );
  }

  static async unreact(buyer: IBuyer, planId: string, messageId: string): Promise<void> {
    const plan = await EventPlanService.loadForAccess(planId);
    const buyerId = String(buyer._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, buyerId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to react to messages');
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid message id');
    await EventPlanMessageReaction.deleteOne({ messageId, buyerId });
  }
}
