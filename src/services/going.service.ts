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

  /**
   * Batch version of {@link goingEventIds} for many buyers at once — resolves
   * memberships + communities + tickets in a FIXED number of queries (3),
   * not 3 per buyer, keyed by buyerId. Built for suggestions'
   * peopleYouMayKnow, which previously called goingEventIds once PER
   * candidate inside a Promise.all — a well-connected viewer could fan out
   * thousands of concurrent queries. Same "going" definition as the
   * per-buyer version (joined community, excluding bans, union live SOLD/
   * CHECKED_IN tickets).
   */
  static async goingEventIdsBatch(buyers: IBuyer[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (buyers.length === 0) return result;
    for (const b of buyers) result.set(String(b._id), new Set());

    const buyerIds = buyers.map((b) => b._id);
    const memberships = await Membership.find({ buyerId: { $in: buyerIds }, bannedAt: { $exists: false } }).select('buyerId communityId');
    const communityIds = [...new Set(memberships.map((m) => String(m.communityId)))];
    const communities = communityIds.length ? await Community.find({ _id: { $in: communityIds } }).select('eventId') : [];
    const eventIdByCommunity = new Map(communities.map((c) => [String(c._id), String(c.eventId)]));
    for (const m of memberships) {
      const eventId = eventIdByCommunity.get(String(m.communityId));
      if (eventId) result.get(String(m.buyerId))?.add(eventId);
    }

    // Group buyers by phone (the ticket-holder key) so ONE query resolves
    // every candidate's ticket-backed events, then fan the results back out
    // to buyerIds in memory.
    const buyerIdsByPhone = new Map<string, string[]>();
    for (const b of buyers) {
      if (!b.phone) continue;
      const list = buyerIdsByPhone.get(b.phone) ?? [];
      list.push(String(b._id));
      buyerIdsByPhone.set(b.phone, list);
    }
    const phones = [...buyerIdsByPhone.keys()];
    const tickets = phones.length
      ? await Ticket.find({ customerPhone: { $in: phones }, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }).select('eventId customerPhone')
      : [];
    for (const t of tickets) {
      if (!t.customerPhone) continue;
      for (const buyerId of buyerIdsByPhone.get(t.customerPhone) ?? []) {
        result.get(buyerId)?.add(String(t.eventId));
      }
    }

    return result;
  }
}
