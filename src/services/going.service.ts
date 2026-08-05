import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import type { IBuyer } from '@models/buyer.model';
import { buyerTicketOr } from '@utils/ticketHolder.util';
import { normalizePhone } from '@utils/phone.util';

export class GoingService {
  /**
   * Events the buyer is "going" to: the union of (a) any event whose
   * community they joined (excluding memberships they were banned from) and
   * (b) any event they hold a live ticket for.
   *
   * "Live ticket" = SOLD or CHECKED_IN — the same holder contract as
   * @utils/ticketHolder.util's isTicketHolder/isTicketHolderForBuyer ("do not
   * diverge"): SOLD covers ticket-holders ahead of the event, CHECKED_IN
   * keeps events visible after the gate scan. AVAILABLE (unsold), REFUNDED
   * and CANCELLED are excluded.
   *
   * Buyer-aware: a ticket counts if it carries the buyer's buyerId, OR their
   * normalized phone, OR their lowercased email (@utils/ticketHolder.util's
   * buyerTicketOr) — an email-only buyer is never matched by an absent
   * customerPhone (that would leak every phone-less ticket's event).
   */
  static async goingEventIds(buyer: IBuyer): Promise<string[]> {
    const memberships = await Membership.find({ buyerId: buyer._id, bannedAt: { $exists: false } }).select('communityId');
    const communityIds = memberships.map((m) => m.communityId);
    const communities = communityIds.length ? await Community.find({ _id: { $in: communityIds } }).select('eventId') : [];
    const joinedEventIds = communities.map((c) => String(c.eventId));

    const ticketEventIds = (
      await Ticket.distinct('eventId', {
        status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
        $or: buyerTicketOr(buyer),
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
   * CHECKED_IN tickets), and the same id/phone/email matching as
   * buyerTicketOr — never emits `{ customerPhone: undefined }`.
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

    // Group buyers by normalized phone / lowercased email (the ticket-match
    // keys), so ONE query resolves every candidate's ticket-backed events,
    // then fan the results back out to buyerIds in memory. buyerId itself is
    // matched directly off each returned ticket (no grouping map needed).
    const phoneToIds = new Map<string, string[]>();
    const emailToIds = new Map<string, string[]>();
    for (const b of buyers) {
      if (b.phone) {
        const key = normalizePhone(b.phone);
        const list = phoneToIds.get(key);
        if (list) list.push(String(b._id));
        else phoneToIds.set(key, [String(b._id)]);
      }
      if (b.email) {
        const key = b.email.toLowerCase();
        const list = emailToIds.get(key);
        if (list) list.push(String(b._id));
        else emailToIds.set(key, [String(b._id)]);
      }
    }

    const or: Record<string, unknown>[] = [{ buyerId: { $in: buyerIds } }];
    if (phoneToIds.size) or.push({ customerPhone: { $in: [...phoneToIds.keys()] } });
    if (emailToIds.size) or.push({ customerEmail: { $in: [...emailToIds.keys()] } });

    const tickets = await Ticket.find({
      status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
      $or: or,
    }).select('eventId customerPhone customerEmail buyerId');

    const knownBuyerIds = new Set(buyerIds.map((id) => String(id)));
    for (const t of tickets) {
      const evt = String(t.eventId);
      const targets = new Set<string>();
      if (t.buyerId && knownBuyerIds.has(String(t.buyerId))) targets.add(String(t.buyerId));
      if (t.customerPhone) for (const id of phoneToIds.get(normalizePhone(t.customerPhone)) ?? []) targets.add(id);
      if (t.customerEmail) for (const id of emailToIds.get(t.customerEmail.toLowerCase()) ?? []) targets.add(id);
      for (const id of targets) result.get(id)?.add(evt);
    }

    return result;
  }
}
