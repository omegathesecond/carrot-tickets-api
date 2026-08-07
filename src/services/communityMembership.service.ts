import { Community } from '@models/community.model';
import { Channel, IChannel } from '@models/channel.model';
import { Membership, IMembership } from '@models/membership.model';
import { Message } from '@models/message.model';
import { Event } from '@models/event.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { isTicketHolderForBuyer } from '@utils/ticketHolder.util';
import { HttpError } from '@utils/httpError.util';
import { OrganizerViewer, assertOrganizerOwnsCommunity } from '@utils/communityViewer.util';
import { assertActorNotSuspended } from '@services/socialAuthor.service';
import { memberKey } from '@utils/communityMember.util';
import type { SocialActor } from '@utils/socialActor.util';

export interface ChannelView {
  id: string;
  name: string;
  slug: string;
  gated: boolean;
  postPolicy: string;
  locked: boolean;
  unreadCount: number | null;
}

export interface CommunityView {
  communityId: string;
  eventId: string;
  channels: ChannelView[];
  membership: { role: string; ticketVerified: boolean; joinedAt: Date } | null;
  /** Active (non-banned) members. Mirrors CommunityController.listMembers'
   *  `bannedAt: { $exists: false }` filter exactly — a divergent filter here
   *  would report a count that disagrees with the list the user opens. */
  memberCount: number;
  /** Set to 'organizer' when the viewer is the managing vendor peeking
   *  read-only (no membership). Absent for buyer/member views. */
  viewerRole?: 'organizer';
}

export class CommunityMembershipService {
  static async join(eventId: string, actor: SocialActor): Promise<CommunityView> {
    await assertActorNotSuspended(actor);
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');

    const key = memberKey(actor);
    // A brand that manages this event joins as 'organizer' (every channel
    // unlocked, may post in organizer-only channels); any other actor joins as
    // a plain 'member'. Ownership is checked against the Event (source of
    // truth), matching assertOrganizerOwnsCommunity.
    const role = (await CommunityMembershipService.actorOwnsEvent(eventId, actor)) ? 'organizer' : 'member';

    let membership = await Membership.findOne({ ...key, communityId: community._id });
    if (!membership) {
      try {
        membership = await Membership.create({ ...key, communityId: community._id, role });
      } catch (err: any) {
        if (err?.code !== 11000) throw err; // double-click race — take the winner's row
        membership = await Membership.findOne({ ...key, communityId: community._id });
      }
    }
    if (!membership) throw new HttpError(500, 'Failed to join community');

    // Ticket verification is a buyer concept — a brand holds no Carrot ticket,
    // so its membership is never ticket-gated (gated channels simply stay
    // locked to a non-organizer brand). Only an event that actually SELLS on
    // Carrot can require a ticket; externally-sold events and community
    // self-listings (no tiers) have none to verify against, so gating those
    // would make "Going" impossible, not selective.
    if (actor.type === 'buyer') {
      const event = await Event.findById(eventId).select('ticketing ticketTypes');
      const sellsOnCarrot = !!event && event.ticketing !== 'external' && (event.ticketTypes?.length ?? 0) > 0;
      const requiresTicket = !event || sellsOnCarrot;
      if (requiresTicket) {
        const buyer = await Buyer.findById(actor.id);
        if (buyer) await CommunityMembershipService.refreshTicketVerification(eventId, buyer, membership);
      }
    }
    return CommunityMembershipService.buildView(String(community._id), eventId, membership);
  }

  /** Community view for a signed-in actor. A buyer or a brand that has JOINED
   *  sees their member view (unread cursors, join affordance resolved). A
   *  brand that manages the event but hasn't joined falls back to the
   *  read-only organizer peek; any other non-member sees the public "can join"
   *  view. */
  static async getView(eventId: string, actor: SocialActor): Promise<CommunityView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');
    const membership = await Membership.findOne({ ...memberKey(actor), communityId: community._id });
    if (membership) {
      return CommunityMembershipService.buildView(String(community._id), eventId, membership);
    }
    // A managing brand that hasn't joined keeps its existing read-only peek.
    if (actor.type === 'vendor' && (await CommunityMembershipService.actorOwnsEvent(eventId, actor))) {
      return CommunityMembershipService.getOrganizerView(eventId, { vendorId: actor.id, isSuperAdmin: false });
    }
    return CommunityMembershipService.buildView(String(community._id), eventId, null);
  }

  /** Does this actor manage the event (a vendor owner)? Buyers never do. */
  private static async actorOwnsEvent(eventId: string, actor: SocialActor): Promise<boolean> {
    if (actor.type !== 'vendor') return false;
    const event = await Event.findById(eventId).select('vendorId');
    return !!event && String(event.vendorId) === actor.id;
  }

  /**
   * Anonymous, read-only community view (who's-going social proof for signed-out
   * visitors). No membership → gated channels read as locked, no unread counts,
   * `membership: null` — same shape a not-yet-joined member would see, minus any
   * personal state. memberCount is the public "who's going" number.
   */
  static async getPublicView(eventId: string): Promise<CommunityView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');
    return CommunityMembershipService.buildView(String(community._id), eventId, null);
  }

  /**
   * Read-only community view for the managing organizer (spec: organizer peek).
   * No Membership is involved — the organizer sees every channel unlocked
   * (they own the event, gating doesn't apply to them), with no unread badges
   * or read cursor. `viewerRole: 'organizer'` tells the client to render
   * read-only (no join, no composer). Throws 403 if they don't own the event.
   */
  static async getOrganizerView(eventId: string, organizer: OrganizerViewer): Promise<CommunityView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');
    await assertOrganizerOwnsCommunity(community, organizer);

    const channels = await Channel.find({ communityId: community._id, archived: false }).sort({ createdAt: 1 });
    const channelViews: ChannelView[] = channels.map((c: IChannel) => ({
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      gated: c.gated,
      postPolicy: c.postPolicy,
      locked: false,
      unreadCount: null,
    }));

    const memberCount = await Membership.countDocuments({
      communityId: community._id,
      bannedAt: { $exists: false },
    });

    return {
      communityId: String(community._id),
      eventId,
      channels: channelViews,
      memberCount,
      membership: null,
      viewerRole: 'organizer',
    };
  }

  static async reverifyTicket(eventId: string, buyer: IBuyer): Promise<CommunityView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');
    const membership = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
    if (!membership) throw new HttpError(403, 'Join the community first');

    await CommunityMembershipService.refreshTicketVerification(eventId, buyer, membership);
    return CommunityMembershipService.buildView(String(community._id), eventId, membership);
  }

  private static async refreshTicketVerification(
    eventId: string,
    buyer: IBuyer,
    membership: IMembership
  ): Promise<void> {
    if (!membership.ticketVerifiedAt && (await isTicketHolderForBuyer(eventId, buyer))) {
      membership.ticketVerifiedAt = new Date();
      await membership.save();
    }
  }

  private static async buildView(
    communityId: string,
    eventId: string,
    membership: IMembership | null
  ): Promise<CommunityView> {
    const channels = await Channel.find({ communityId, archived: false }).sort({ createdAt: 1 });
    // A brand that manages the event (role 'organizer') sees every channel
    // unlocked — it owns the gating, it isn't subject to it. Everyone else
    // needs a verified ticket for gated channels.
    const verified = Boolean(membership?.ticketVerifiedAt) || membership?.role === 'organizer';

    const channelViews: ChannelView[] = await Promise.all(
      channels.map(async (c: IChannel) => {
        const locked = c.gated && !verified;
        let unreadCount: number | null = null;
        if (membership && !locked) {
          // Unread since the read cursor, or since joining for never-read
          // channels. createdAt keeps millisecond precision (an ObjectId
          // cursor would round to seconds and miscount around a mark-read).
          const since = membership.readState.get(String(c._id)) ?? membership.createdAt;
          unreadCount = await Message.countDocuments(
            { channelId: c._id, createdAt: { $gt: since } },
            { limit: 99 } // badge caps at 99 — never scan an entire hot channel
          );
        }
        return {
          id: String(c._id),
          name: c.name,
          slug: c.slug,
          gated: c.gated,
          postPolicy: c.postPolicy,
          locked,
          unreadCount,
        };
      })
    );

    const memberCount = await Membership.countDocuments({
      communityId,
      bannedAt: { $exists: false },
    });

    return {
      communityId,
      eventId,
      channels: channelViews,
      memberCount,
      membership: membership
        ? { role: membership.role, ticketVerified: verified, joinedAt: membership.createdAt }
        : null,
    };
  }
}
