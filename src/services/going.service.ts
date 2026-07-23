import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import type { IBuyer } from '@models/buyer.model';

export class GoingService {
  /**
   * Events the buyer is "going" to: the union of (a) any event whose
   * community they joined (excluding memberships they were banned from) and
   * (b) any event they hold a live ticket for.
   *
   * "Live ticket" = SOLD or CHECKED_IN — the same holder contract as
   * @utils/ticketHolder.util's isTicketHolder ("do not diverge"): SOLD covers
   * ticket-holders ahead of the event, CHECKED_IN keeps events visible after
   * the gate scan. AVAILABLE (unsold), REFUNDED and CANCELLED are excluded.
   */
  static async goingEventIds(buyer: IBuyer): Promise<string[]> {
    const memberships = await Membership.find({ buyerId: buyer._id, bannedAt: { $exists: false } }).select('communityId');
    const communityIds = memberships.map((m) => m.communityId);
    const communities = communityIds.length ? await Community.find({ _id: { $in: communityIds } }).select('eventId') : [];
    const joinedEventIds = communities.map((c) => String(c.eventId));

    const ticketEventIds = (
      await Ticket.distinct('eventId', {
        customerPhone: buyer.phone,
        status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
      })
    ).map((id: any) => String(id));

    return [...new Set([...joinedEventIds, ...ticketEventIds])];
  }
}
