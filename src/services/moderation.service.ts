import { Message, IMessage } from '@models/message.model';
import { Membership, IMembership } from '@models/membership.model';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { MessageService } from '@services/message.service';

const PIN_LIMIT = 10;

export interface AdminMemberView extends BuyerSummary {
  role: string;
  ticketVerified: boolean;
  mutedUntil: Date | null;
  bannedAt: Date | null;
  joinedAt: Date;
  cursor: string;
}

/**
 * Organizer moderation over a community: delete-any, mute/ban, pins, and the
 * admin member list. Every method here takes an already-fetched, already
 * ownership-checked document — the controller owns the 404/EDIT_EVENT +
 * ownership walk (community -> event -> vendorId), mirroring
 * ChannelAdminService's split (see channelAdmin.service.ts).
 */
export class ModerationService {
  /**
   * Delete ANY channel message in a community the organizer owns. Reuses
   * MessageService.softDeleteChannelMessage so `message:deleted` broadcasts
   * identically for self-delete and moderator delete-any — see that method's
   * docstring in message.service.ts for why this must not be forked.
   */
  static async deleteMessage(message: IMessage): Promise<void> {
    await MessageService.softDeleteChannelMessage(message);
  }

  static async mute(membership: IMembership, minutes: number): Promise<Date> {
    membership.mutedUntil = new Date(Date.now() + minutes * 60_000);
    await membership.save();
    return membership.mutedUntil;
  }

  static async unmute(membership: IMembership): Promise<void> {
    membership.mutedUntil = undefined;
    await membership.save();
  }

  static async ban(membership: IMembership): Promise<Date> {
    membership.bannedAt = new Date();
    await membership.save();
    return membership.bannedAt;
  }

  static async unban(membership: IMembership): Promise<void> {
    membership.bannedAt = undefined;
    await membership.save();
  }

  /**
   * GET /api/tickets/communities/:communityId/members — admin roster.
   * Mirrors CommunityController.listMembers' cursor pagination exactly, but
   * WITHOUT the buyer-facing `bannedAt: { $exists: false }` filter (admins
   * need to see who's banned), and enriches each row with moderation state.
   */
  static async listMembers(
    communityId: string,
    opts: { before?: string; limit?: number }
  ): Promise<AdminMemberView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { communityId };
    if (opts.before) query['_id'] = { $lt: opts.before };

    const memberships = await Membership.find(query).sort({ _id: -1 }).limit(limit).populate('buyerId');
    return memberships
      .filter((m: any) => m.buyerId && typeof m.buyerId === 'object')
      .map((m: any) => ({
        ...toBuyerSummary(m.buyerId),
        role: m.role,
        ticketVerified: Boolean(m.ticketVerifiedAt),
        mutedUntil: m.mutedUntil ?? null,
        bannedAt: m.bannedAt ?? null,
        joinedAt: m.createdAt,
        cursor: String(m._id),
      }));
  }

  /**
   * Pin is idempotent (re-pinning an already-pinned message is a no-op and
   * never counts twice against the cap). Cap is enforced with `$ne: null`,
   * which — per Mongo's null-comparison semantics — excludes both explicit
   * `null` (unpinned) and the unset field (never pinned).
   *
   * INVARIANT / concurrency note: this is deliberately NOT a
   * countDocuments-then-save check. That ordering is a TOCTOU race — two
   * concurrent pins reading a count of 9 both pass "9 < 10" and both save,
   * landing 11 pinned. Instead we set-then-recount-then-rollback: set
   * pinnedAt optimistically, recount, and if the cap was exceeded roll THIS
   * write back. No transaction is used (admin-QPS endpoint, not worth the
   * complexity) — a transient over-cap state can exist for the instant
   * between two concurrent saves, but the very next recount on either racer
   * observes count > PIN_LIMIT and rolls its own write back, so the
   * collection self-corrects to <= PIN_LIMIT before either request returns
   * to its caller (whichever request's rollback save wins the row simply
   * ends up unpinned — the other stays pinned, holding the cap exactly).
   */
  static async pinMessage(message: IMessage): Promise<void> {
    if (message.pinnedAt) return;
    message.pinnedAt = new Date();
    await message.save();

    const count = await Message.countDocuments({
      channelId: message.channelId,
      pinnedAt: { $ne: null },
    });
    if (count > PIN_LIMIT) {
      message.pinnedAt = null;
      await message.save();
      throw new HttpError(400, 'Pin limit reached');
    }
  }

  static async unpinMessage(message: IMessage): Promise<void> {
    if (!message.pinnedAt) return;
    message.pinnedAt = null;
    await message.save();
  }
}
