import { Community } from '@models/community.model';
import { Channel, IChannel } from '@models/channel.model';
import { Membership, IMembership } from '@models/membership.model';
import { IBuyer } from '@models/buyer.model';
import { isTicketHolder } from '@utils/ticketHolder.util';
import { HttpError } from '@utils/httpError.util';

export interface ChannelView {
  id: string;
  name: string;
  slug: string;
  gated: boolean;
  postPolicy: string;
  locked: boolean;
}

export interface CommunityView {
  communityId: string;
  eventId: string;
  channels: ChannelView[];
  membership: { role: string; ticketVerified: boolean; joinedAt: Date } | null;
}

export class CommunityMembershipService {
  static async join(eventId: string, buyer: IBuyer): Promise<CommunityView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');

    let membership = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
    if (!membership) {
      try {
        membership = await Membership.create({ buyerId: buyer._id, communityId: community._id });
      } catch (err: any) {
        if (err?.code !== 11000) throw err; // double-click race — take the winner's row
        membership = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
      }
    }
    if (!membership) throw new HttpError(500, 'Failed to join community');

    await CommunityMembershipService.refreshTicketVerification(eventId, buyer, membership);
    return CommunityMembershipService.buildView(String(community._id), eventId, membership);
  }

  static async getView(eventId: string, buyer: IBuyer): Promise<CommunityView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');
    const membership = await Membership.findOne({ buyerId: buyer._id, communityId: community._id });
    return CommunityMembershipService.buildView(String(community._id), eventId, membership);
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
    if (!membership.ticketVerifiedAt && (await isTicketHolder(eventId, buyer.phone))) {
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
    const verified = Boolean(membership?.ticketVerifiedAt);
    return {
      communityId,
      eventId,
      channels: channels.map((c: IChannel) => ({
        id: String(c._id),
        name: c.name,
        slug: c.slug,
        gated: c.gated,
        postPolicy: c.postPolicy,
        locked: c.gated && !verified,
      })),
      membership: membership
        ? { role: membership.role, ticketVerified: verified, joinedAt: membership.createdAt }
        : null,
    };
  }
}
