import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Message } from '@models/message.model';
import { IBuyer } from '@models/buyer.model';
import { isTicketHolder } from '@utils/ticketHolder.util';
import { consumeToken } from '@utils/rateLimit.util';
import { HttpError } from '@utils/httpError.util';
import { emitToRoom, isSocketEmitterInitialized } from '@/realtime/emitter';
import { channelRoom, dmRoom } from '@/realtime/rooms';
import { DmThreadService } from '@services/dmThread.service';
import { BlockService } from '@services/block.service';

export interface MessageView {
  id: string;
  channelId: string | null;
  dmThreadId: string | null;
  body: string;
  deleted: boolean;
  replyTo: string | null;
  sender: { id: string; username: string | null; name: string | null; avatarUrl: string | null } | null;
  createdAt: Date;
  editedAt: Date | null;
}

export class MessageService {
  /**
   * Shared authz for reading/writing a channel: member of the community,
   * not banned, and (for gated channels) a verified ticket holder — with an
   * on-demand re-check so a purchase unlocks access without an extra call.
   *
   * Also used by the realtime gateway's channel:join (see
   * src/realtime/channelHandlers.ts), so WS room membership can never be
   * broader than REST access.
   */
  static async requireChannelAccess(channelId: string, buyer: IBuyer) {
    const channel = await Channel.findById(channelId);
    if (!channel || channel.archived) throw new HttpError(404, 'Channel not found');

    const community = await Community.findById(channel.communityId);
    if (!community) throw new HttpError(404, 'Community not found');

    const membership = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
    if (!membership) throw new HttpError(403, 'Join the community first');
    if (membership.bannedAt) throw new HttpError(403, 'You have been banned from this community');

    if (channel.gated && !membership.ticketVerifiedAt) {
      if (await isTicketHolder(String(community.eventId), buyer.phone)) {
        membership.ticketVerifiedAt = new Date();
        await membership.save();
      } else {
        throw new HttpError(403, 'This channel is for ticket holders only');
      }
    }

    return { channel, community, membership };
  }

  /**
   * Best-effort live broadcast AFTER the durable write (see emitter module
   * for why async bus failures can't reach us here).
   */
  private static broadcastRoom(room: string, event: string, payload: unknown): void {
    if (!isSocketEmitterInitialized()) return;
    try {
      emitToRoom(room, event, payload);
    } catch (err) {
      console.error('[realtime-emit] broadcast failed (clients recover via resync):', err);
    }
  }

  private static async listWithCursor(
    filter: Record<string, unknown>,
    opts: { before?: string; after?: string; limit?: number }
  ): Promise<MessageView[]> {
    if (opts.before && opts.after) {
      throw new HttpError(400, 'before and after are mutually exclusive');
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const query: Record<string, unknown> = { ...filter };
    let sort: Record<string, 1 | -1> = { _id: -1 };
    if (opts.before) query['_id'] = { $lt: opts.before };
    if (opts.after) {
      query['_id'] = { $gt: opts.after };
      sort = { _id: 1 };
    }
    const docs = await Message.find(query).sort(sort).limit(limit).populate('senderId', 'username name avatarUrl');
    return docs.map((doc) => MessageService.toView(doc));
  }

  static async listMessages(
    channelId: string,
    buyer: IBuyer,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): Promise<MessageView[]> {
    await MessageService.requireChannelAccess(channelId, buyer);
    return MessageService.listWithCursor({ channelId }, opts);
  }

  static async listDmMessages(
    threadId: string,
    buyer: IBuyer,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): Promise<MessageView[]> {
    const thread = await DmThreadService.requireDmAccess(threadId, buyer);
    return MessageService.listWithCursor({ dmThreadId: thread._id }, opts);
  }

  static async sendMessage(
    channelId: string,
    buyer: IBuyer,
    input: { body: string; replyTo?: string }
  ): Promise<MessageView> {
    const { channel, community, membership } = await MessageService.requireChannelAccess(channelId, buyer);

    if (channel.postPolicy === 'organizer') {
      throw new HttpError(403, 'Only the organizer can post in this channel');
    }
    if (membership.mutedUntil && membership.mutedUntil > new Date()) {
      throw new HttpError(403, 'You are muted in this community');
    }
    if (!consumeToken(`msg:${String(buyer._id)}`)) {
      throw new HttpError(429, 'You are sending messages too quickly — slow down');
    }

    const message = await Message.create({
      channelId: channel._id,
      communityId: community._id,
      senderId: buyer._id,
      body: input.body,
      replyTo: input.replyTo || undefined,
    });
    await message.populate('senderId', 'username name avatarUrl');
    const view = MessageService.toView(message);
    MessageService.broadcastRoom(channelRoom(String(channel._id)), 'message:new', view);
    return view;
  }

  static async sendDmMessage(
    threadId: string,
    buyer: IBuyer,
    input: { body: string; replyTo?: string }
  ): Promise<MessageView> {
    const thread = await DmThreadService.requireDmAccess(threadId, buyer);

    // Blocks are re-checked at send time for 1:1 threads — "server-refused
    // DMs" (spec §5.3) must hold even for threads opened before the block.
    if (!thread.isGroup) {
      const other = thread.participants.find((p) => String(p) !== String(buyer._id));
      if (other && (await BlockService.isBlockedEitherWay(String(buyer._id), String(other)))) {
        throw new HttpError(403, 'You cannot message this user');
      }
    }

    if (!consumeToken(`msg:${String(buyer._id)}`)) {
      throw new HttpError(429, 'You are sending messages too quickly — slow down');
    }

    const message = await Message.create({
      dmThreadId: thread._id,
      senderId: buyer._id,
      body: input.body,
      replyTo: input.replyTo || undefined,
    });
    thread.lastMessageAt = new Date();
    thread.readState.set(String(buyer._id), new Date());
    await thread.save();

    await message.populate('senderId', 'username name avatarUrl');
    const view = MessageService.toView(message);
    MessageService.broadcastRoom(dmRoom(String(thread._id)), 'message:new', view);
    return view;
  }

  static async markDmRead(threadId: string, buyer: IBuyer): Promise<void> {
    const thread = await DmThreadService.requireDmAccess(threadId, buyer);
    thread.readState.set(String(buyer._id), new Date());
    await thread.save();
  }

  static async deleteOwnMessage(messageId: string, buyer: IBuyer): Promise<void> {
    const message = await Message.findById(messageId);
    if (!message || message.deletedAt) throw new HttpError(404, 'Message not found');
    if (String(message.senderId) !== String(buyer._id)) {
      throw new HttpError(403, 'You can only delete your own messages');
    }

    if (message.dmThreadId) {
      await DmThreadService.requireDmAccess(String(message.dmThreadId), buyer);
      message.deletedAt = new Date();
      await message.save();
      MessageService.broadcastRoom(dmRoom(String(message.dmThreadId)), 'message:deleted', {
        dmThreadId: String(message.dmThreadId),
        messageId: String(message._id),
      });
      return;
    }

    // "Banned members are blocked everywhere" — including cleaning up their
    // own history. The message carries communityId, so no channel load needed.
    const membership = await Membership.findOne({
      buyerId: buyer._id,
      communityId: message.communityId,
    });
    if (!membership) throw new HttpError(403, 'Join the community first');
    if (membership.bannedAt) throw new HttpError(403, 'You have been banned from this community');

    message.deletedAt = new Date();
    await message.save();

    MessageService.broadcastRoom(channelRoom(String(message.channelId)), 'message:deleted', {
      channelId: String(message.channelId),
      messageId: String(message._id),
    });
  }

  /** Stamp the buyer's read cursor for a channel (drives unread badges). */
  static async markRead(channelId: string, buyer: IBuyer): Promise<void> {
    const { channel, membership } = await MessageService.requireChannelAccess(channelId, buyer);
    // Key by the CANONICAL id — the raw param can arrive as uppercase hex,
    // which casts fine for queries but would orphan the Map entry the view
    // reads back via String(channel._id).
    membership.readState.set(String(channel._id), new Date());
    await membership.save();
  }

  private static toView(doc: any): MessageView {
    const deleted = Boolean(doc.deletedAt);
    const sender =
      doc.senderId && typeof doc.senderId === 'object' && doc.senderId._id
        ? {
            id: String(doc.senderId._id),
            username: doc.senderId.username ?? null,
            name: doc.senderId.name ?? null,
            avatarUrl: doc.senderId.avatarUrl ?? null,
          }
        : null;
    return {
      id: String(doc._id),
      channelId: doc.channelId ? String(doc.channelId) : null,
      dmThreadId: doc.dmThreadId ? String(doc.dmThreadId) : null,
      body: deleted ? '' : doc.body,
      deleted,
      replyTo: doc.replyTo ? String(doc.replyTo) : null,
      sender: deleted ? null : sender,
      createdAt: doc.createdAt,
      editedAt: doc.editedAt ?? null,
    };
  }
}
