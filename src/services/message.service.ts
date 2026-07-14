import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Message, IMessage } from '@models/message.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { isTicketHolder } from '@utils/ticketHolder.util';
import { consumeToken } from '@utils/rateLimit.util';
import { HttpError } from '@utils/httpError.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import { emitToRoom, isSocketEmitterInitialized } from '@/realtime/emitter';
import { channelRoom, dmRoom } from '@/realtime/rooms';
import { DmThreadService } from '@services/dmThread.service';
import { IDmThread } from '@models/dmThread.model';
import { BlockService } from '@services/block.service';
import { FollowService } from '@services/follow.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { NotificationService } from '@services/notification.service';
import mongoose from 'mongoose';
import type { SocialActor } from '@utils/socialActor.util';

export interface MessageView {
  id: string;
  channelId: string | null;
  dmThreadId: string | null;
  body: string;
  deleted: boolean;
  replyTo: string | null;
  sender: { id: string; username: string | null; name: string | null; avatarUrl: string | null } | null;
  senderType: 'buyer' | 'organizer';
  createdAt: Date;
  editedAt: Date | null;
  pinnedAt: Date | null;
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
    if (!channel) throw new HttpError(404, 'Channel not found');
    if (channel.archived) throw new HttpError(403, 'This channel is archived');

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

  private static trunc(body: string, max = 140): string {
    return body.length <= max ? body : `${body.slice(0, max - 1)}…`;
  }

  /** Resolve @username mentions (cap 10) to un-banned members of the
   *  community, excluding the sender. Returns their buyer ids. */
  private static async resolveChannelMentions(
    body: string,
    communityId: string,
    senderId: string
  ): Promise<string[]> {
    // Case-insensitive with a left boundary: '@Friend_Two' should mention
    // friend_two (usernames are stored lowercase), while 'foo@gmail.com'
    // must not treat '@gmail' as a mention.
    const usernames = [
      ...new Set(
        [...body.matchAll(/(?<![a-zA-Z0-9_.])@([a-zA-Z0-9_]{3,20})/g)].map((m) => m[1]!.toLowerCase())
      ),
    ].slice(0, 10);
    if (usernames.length === 0) return [];
    const buyers = await Buyer.find({ username: { $in: usernames } }).select('_id');
    const candidateIds = buyers.map((b) => String(b._id)).filter((id) => id !== senderId);
    if (candidateIds.length === 0) return [];
    const members = await Membership.find({
      communityId,
      buyerId: { $in: candidateIds },
      bannedAt: { $exists: false },
    }).select('buyerId');
    return members.map((m) => String(m.buyerId));
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
    const docs = await Message.find(query)
      .sort(sort)
      .limit(limit)
      .populate('senderId', 'username name avatarUrl')
      .populate('senderVendorId', 'businessName logoUrl');
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
    actor: SocialActor,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): Promise<MessageView[]> {
    const thread = await DmThreadService.requireDmAccess(threadId, actor);
    return MessageService.listWithCursor({ dmThreadId: thread._id }, opts);
  }

  static async sendMessage(
    channelId: string,
    buyer: IBuyer,
    input: { body: string; replyTo?: string }
  ): Promise<MessageView> {
    assertNotSuspended(buyer);
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

    const mentionIds = await MessageService.resolveChannelMentions(
      input.body,
      String(community._id),
      String(buyer._id)
    );

    const message = await Message.create({
      channelId: channel._id,
      communityId: community._id,
      senderId: buyer._id,
      body: input.body,
      replyTo: input.replyTo || undefined,
      mentions: mentionIds,
    });
    await message.populate('senderId', 'username name avatarUrl');
    await message.populate('senderVendorId', 'businessName logoUrl');
    const view = MessageService.toView(message);
    MessageService.broadcastRoom(channelRoom(String(channel._id)), 'message:new', view);

    if (mentionIds.length > 0) {
      NotificationDispatcher.dispatchAsync(
        mentionIds,
        'mention',
        buyer.username ?? buyer.name ?? 'Mention',
        MessageService.trunc(input.body),
        { eventId: String(community.eventId), channelId: String(channel._id), messageId: view.id },
        String(buyer._id)
      );
    }
    return view;
  }

  static async sendDmMessage(
    threadId: string,
    actor: SocialActor,
    input: { body: string; replyTo?: string }
  ): Promise<MessageView> {
    const thread = await DmThreadService.requireDmAccess(threadId, actor);

    // Suspension + block gates apply to buyer senders (a brand isn't suspended
    // or blockable through this path). Buyer↔buyer blocks are re-checked at
    // send time — "server-refused DMs" must hold even for pre-block threads.
    if (actor.type === 'buyer') {
      const sender = await Buyer.findById(actor.id);
      if (!sender) throw new HttpError(404, 'Account not found');
      assertNotSuspended(sender);
      if (!thread.isGroup && !thread.vendorParticipantId) {
        const other = thread.participants.find((p) => String(p) !== actor.id);
        if (other && (await BlockService.isBlockedEitherWay(actor.id, String(other)))) {
          throw new HttpError(403, 'You cannot message this user');
        }
      }
    }

    // Preserve the buyer's shared open-thread/send budget (`msg:<buyerId>`);
    // a brand shares its own budget with openVendorThread (`msg:v:<vendorId>`).
    const rateKey = actor.type === 'buyer' ? `msg:${actor.id}` : `msg:v:${actor.id}`;
    if (!consumeToken(rateKey)) {
      throw new HttpError(429, 'You are sending messages too quickly — slow down');
    }

    const message = await Message.create({
      dmThreadId: thread._id,
      ...(actor.type === 'buyer'
        ? { senderId: new mongoose.Types.ObjectId(actor.id) }
        : { senderVendorId: new mongoose.Types.ObjectId(actor.id) }),
      body: input.body,
      replyTo: input.replyTo || undefined,
    });
    thread.lastMessageAt = new Date();
    thread.readState.set(actor.id, new Date());
    await thread.save();

    await message.populate('senderId', 'username name avatarUrl');
    await message.populate('senderVendorId', 'businessName logoUrl');
    const view = MessageService.toView(message);
    MessageService.broadcastRoom(dmRoom(String(thread._id)), 'message:new', view);

    await MessageService.notifyDmRecipients(thread, actor, input.body, view.id);
    return view;
  }

  /** Notify the other party of a new DM: buyers via the dispatcher (inbox +
   *  push when offline), the brand via a vendor inbox row (no push). */
  private static async notifyDmRecipients(
    thread: IDmThread,
    actor: SocialActor,
    body: string,
    messageId: string
  ): Promise<void> {
    const preview = MessageService.trunc(body);
    if (actor.type === 'buyer') {
      const sender = await Buyer.findById(actor.id).select('username name');
      const title = sender?.username ?? sender?.name ?? 'New message';
      const otherBuyers = thread.participants.map(String).filter((id) => id !== actor.id);
      if (otherBuyers.length) {
        NotificationDispatcher.dispatchAsync(otherBuyers, 'dm', title, preview, { threadId: String(thread._id), messageId }, actor.id);
      }
      if (thread.vendorParticipantId) {
        await NotificationService.create('vendor', String(thread.vendorParticipantId), 'dm', 'New message', `${title}: ${preview}`, { threadId: String(thread._id), messageId }).catch(() => undefined);
      }
    } else {
      const vendor = await Vendor.findById(actor.id).select('businessName');
      const buyers = thread.participants.map(String);
      if (buyers.length) {
        NotificationDispatcher.dispatchAsync(buyers, 'dm', vendor?.businessName ?? 'A brand', preview, { threadId: String(thread._id), messageId }, actor.id);
      }
    }
  }

  static async markDmRead(threadId: string, actor: SocialActor): Promise<void> {
    const thread = await DmThreadService.requireDmAccess(threadId, actor);
    thread.readState.set(actor.id, new Date());
    await thread.save();
  }

  /**
   * Soft-delete a CHANNEL message and broadcast `message:deleted` on its
   * channel room. Shared by self-delete (below) and organizer moderation
   * delete-any (see ModerationService.deleteMessage) so the broadcast path
   * can never drift between the two callers — do not fork this logic.
   * Caller owns all authz/ownership checks; this only persists + emits.
   *
   * Also auto-unpins (deleted messages can never stay pinned) — same write,
   * no extra save, no new bus event.
   */
  static async softDeleteChannelMessage(message: IMessage): Promise<void> {
    message.deletedAt = new Date();
    message.pinnedAt = null;
    await message.save();
    MessageService.broadcastRoom(channelRoom(String(message.channelId)), 'message:deleted', {
      channelId: String(message.channelId),
      messageId: String(message._id),
    });
  }

  static async deleteOwnMessage(messageId: string, buyer: IBuyer): Promise<void> {
    const message = await Message.findById(messageId);
    if (!message || message.deletedAt) throw new HttpError(404, 'Message not found');
    if (String(message.senderId) !== String(buyer._id)) {
      throw new HttpError(403, 'You can only delete your own messages');
    }

    if (message.dmThreadId) {
      await DmThreadService.requireDmAccess(String(message.dmThreadId), { type: 'buyer', id: String(buyer._id) });
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

    await MessageService.softDeleteChannelMessage(message);
  }

  /**
   * GET /api/community/channels/:channelId/pins — buyer read, same access
   * gate as listMessages (requireChannelAccess). Newest-pinned-first, capped
   * at 10 (the same cap ModerationService.pinMessage enforces on write).
   */
  static async listPinnedMessages(channelId: string, buyer: IBuyer): Promise<MessageView[]> {
    await MessageService.requireChannelAccess(channelId, buyer);
    const docs = await Message.find({ channelId, pinnedAt: { $ne: null } })
      .sort({ pinnedAt: -1 })
      .limit(10)
      .populate('senderId', 'username name avatarUrl')
      .populate('senderVendorId', 'businessName logoUrl');
    return docs.map((doc) => MessageService.toView(doc));
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
    const isOrganizer = Boolean(doc.senderVendorId);
    let sender: MessageView['sender'] = null;
    if (!deleted) {
      if (isOrganizer && typeof doc.senderVendorId === 'object' && doc.senderVendorId._id) {
        sender = {
          id: String(doc.senderVendorId._id),
          username: null,
          name: doc.senderVendorId.businessName ?? null,
          avatarUrl: doc.senderVendorId.logoUrl ?? null,
        };
      } else if (doc.senderId && typeof doc.senderId === 'object' && doc.senderId._id) {
        sender = {
          id: String(doc.senderId._id),
          username: doc.senderId.username ?? null,
          name: doc.senderId.name ?? null,
          avatarUrl: doc.senderId.avatarUrl ?? null,
        };
      }
    }
    return {
      id: String(doc._id),
      channelId: doc.channelId ? String(doc.channelId) : null,
      dmThreadId: doc.dmThreadId ? String(doc.dmThreadId) : null,
      body: deleted ? '' : doc.body,
      deleted,
      replyTo: doc.replyTo ? String(doc.replyTo) : null,
      sender,
      senderType: isOrganizer ? 'organizer' : 'buyer',
      createdAt: doc.createdAt,
      editedAt: doc.editedAt ?? null,
      pinnedAt: doc.pinnedAt ?? null,
    };
  }

  /**
   * Organizer post into the event's #announcements channel (spec §5.1 write
   * path — push fan-out arrives in Plan 5). Same durable-write-then-broadcast
   * shape as buyer sends; the sender is the VENDOR, rendered with brand
   * identity by toView.
   */
  static async postAnnouncement(eventId: string, vendorId: string, body: string): Promise<MessageView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');
    const channel = await Channel.findOne({ communityId: community._id, slug: 'announcements', archived: false });
    if (!channel) throw new HttpError(404, 'Announcements channel not found');

    if (!consumeToken(`msg:${vendorId}`)) {
      throw new HttpError(429, 'You are sending messages too quickly — slow down');
    }

    const message = await Message.create({
      channelId: channel._id,
      communityId: community._id,
      senderVendorId: vendorId,
      body,
    });
    await message.populate('senderVendorId', 'businessName logoUrl');
    const view = MessageService.toView(message);
    MessageService.broadcastRoom(channelRoom(String(channel._id)), 'message:new', view);

    const [memberRows, followerIds] = await Promise.all([
      Membership.find({ communityId: community._id, bannedAt: { $exists: false } }).select('buyerId'),
      FollowService.organizerFollowerIds(vendorId),
    ]);
    const recipients = [...new Set([...memberRows.map((m) => String(m.buyerId)), ...followerIds])];
    NotificationDispatcher.dispatchAsync(
      recipients,
      'announcement',
      view.sender?.name ?? 'Announcement',
      MessageService.trunc(body),
      { eventId, channelId: String(channel._id), messageId: view.id }
    );
    return view;
  }
}
