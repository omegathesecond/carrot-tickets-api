import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Message } from '@models/message.model';
import { IBuyer } from '@models/buyer.model';
import { isTicketHolder } from '@utils/ticketHolder.util';
import { consumeToken } from '@utils/rateLimit.util';
import { HttpError } from '@utils/httpError.util';

export interface MessageView {
  id: string;
  channelId: string;
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

  static async listMessages(
    channelId: string,
    buyer: IBuyer,
    opts: { before?: string; limit?: number } = {}
  ): Promise<MessageView[]> {
    await MessageService.requireChannelAccess(channelId, buyer);

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const query: Record<string, unknown> = { channelId };
    if (opts.before) query['_id'] = { $lt: opts.before };

    const docs = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('senderId', 'username name avatarUrl');

    return docs.map((doc) => MessageService.toView(doc));
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
    return MessageService.toView(message);
  }

  static async deleteOwnMessage(messageId: string, buyer: IBuyer): Promise<void> {
    const message = await Message.findById(messageId);
    if (!message || message.deletedAt) throw new HttpError(404, 'Message not found');
    if (String(message.senderId) !== String(buyer._id)) {
      throw new HttpError(403, 'You can only delete your own messages');
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
      channelId: String(doc.channelId),
      body: deleted ? '' : doc.body,
      deleted,
      replyTo: doc.replyTo ? String(doc.replyTo) : null,
      sender: deleted ? null : sender,
      createdAt: doc.createdAt,
      editedAt: doc.editedAt ?? null,
    };
  }
}
