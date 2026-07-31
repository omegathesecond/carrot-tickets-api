import { Membership } from '@models/membership.model';
import { Community } from '@models/community.model';
import { Ticket } from '@models/ticket.model';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from './types';

/** Live-ticket contract, identical to GoingService's. Do not diverge. */
const LIVE = [TicketStatus.SOLD, TicketStatus.CHECKED_IN];

interface Row {
  buyerId: string;
  eventId: string;
  at: Date;
  sourceId: string;
}

const pairKey = (buyerId: string, eventId: string) => `${buyerId}|${eventId}`;

/**
 * "Going" candidates: the union of community joins and live tickets, matching
 * GoingService's definition exactly.
 *
 * A buyer who both joined and holds a ticket would yield two rows for one
 * (buyer, event) pair. The dedupe rule is page-INDEPENDENT: the pair's
 * timestamp is min(joinedAt, earliest live ticketAt), and only the row that
 * produced that minimum is emitted. The minimum comes from UNWINDOWED lookups
 * (no `before`), so a twin row surfacing on a much later page still fails the
 * check and stays suppressed. Deduping only within a page would leak
 * duplicates across pages.
 *
 * Suspension is NOT filtered here — hydrate() drops suspended actors centrally
 * for all six sources.
 *
 * The two per-source windows (memberships, tickets) are each capped at
 * `limit` independently, but they share one `before` watermark advanced by
 * the caller. When one source is far busier than the other, its window can
 * "crowd out" older rows before the other source's window even gets close —
 * e.g. enough new tickets exist that a buyer's own (much older) ticket falls
 * outside this call's ticket window entirely, while their join for the same
 * event is still comfortably inside the membership window. If we then
 * emitted every candidate this call resolved, the caller would set its next
 * `before` from the oldest row it saw — which could land ABOVE that buyer's
 * hidden ticket, permanently skipping past it on every future page (the
 * pair would never surface again, on any page). So: whenever a sub-query
 * came back full (hit `limit`, meaning older rows may exist beyond it that
 * we didn't fetch), we clamp the FINAL candidate set to rows at or after the
 * oldest fetched row of that source — for every pair, not just ones we can
 * tell are affected, since we can't know which unresolved rows are hiding
 * below the cut. Rows below that boundary are withheld this call and
 * deferred to whichever future call's window reaches them; they are never
 * dropped, because the clamp guarantees the watermark can't advance past
 * them.
 */
export async function goingCandidates(opts: {
  before?: Date;
  limit: number;
  actorIds?: string[] | null;
}): Promise<ActivityCandidate[]> {
  const { before, limit, actorIds } = opts;

  // ---- 1. window: newest rows from each source ----
  const membershipQuery: any = { bannedAt: { $exists: false } };
  if (before) membershipQuery.createdAt = { $lt: before };
  if (actorIds) membershipQuery.buyerId = { $in: actorIds };
  const memberships = await Membership.find(membershipQuery)
    .sort({ createdAt: -1 }).limit(limit).select('buyerId communityId createdAt').lean();

  const ticketQuery: any = { status: { $in: LIVE } };
  if (before) ticketQuery.createdAt = { $lt: before };
  const tickets = await Ticket.find(ticketQuery)
    .sort({ createdAt: -1 }).limit(limit).select('customerPhone eventId createdAt').lean();

  // A full sub-query (hit `limit`) means older rows of that source may exist
  // past the oldest one we fetched — completeness is only guaranteed at or
  // after that point. See the boundary clamp at the bottom of this function.
  const membershipFull = limit > 0 && memberships.length === limit;
  const ticketFull = limit > 0 && tickets.length === limit;
  const boundary =
    membershipFull || ticketFull
      ? Math.max(
          membershipFull ? (memberships[memberships.length - 1]!.createdAt as Date).getTime() : -Infinity,
          ticketFull ? (tickets[tickets.length - 1]!.createdAt as Date).getTime() : -Infinity
        )
      : undefined;

  // ---- 2. resolve every windowed row to a (buyerId, eventId) pair ----
  const windowCommunities = memberships.length
    ? await Community.find({ _id: { $in: memberships.map((m) => m.communityId) } }).select('eventId').lean()
    : [];
  const eventIdByCommunity = new Map(windowCommunities.map((c) => [String(c._id), String(c.eventId)]));

  const windowPhones = [...new Set(tickets.map((t) => t.customerPhone).filter(Boolean))] as string[];
  const windowBuyers = windowPhones.length
    ? await Buyer.find({ phone: { $in: windowPhones } }).select('phone').lean()
    : [];
  const buyerIdByPhone = new Map(windowBuyers.map((b) => [b.phone, String(b._id)]));

  const rows: Row[] = [];
  for (const m of memberships) {
    const eventId = eventIdByCommunity.get(String(m.communityId));
    if (!eventId) continue;
    rows.push({ buyerId: String(m.buyerId), eventId, at: m.createdAt as Date, sourceId: String(m._id) });
  }
  for (const t of tickets) {
    // A POS walk-up sale has no Carrot account behind the phone — no actor,
    // no row. Never invent one.
    const buyerId = t.customerPhone ? buyerIdByPhone.get(t.customerPhone) : undefined;
    if (!buyerId) continue;
    if (actorIds && !actorIds.includes(buyerId)) continue;
    rows.push({ buyerId, eventId: String(t.eventId), at: t.createdAt as Date, sourceId: String(t._id) });
  }
  if (rows.length === 0) return [];

  const buyerIds = [...new Set(rows.map((r) => r.buyerId))];
  const eventIds = [...new Set(rows.map((r) => r.eventId))];

  // ---- 3. published filter. Ended events are KEPT: this is history, not
  //         discovery, so notEndedFilter must NOT be used here. ----
  const publishedDocs = await Event.find({ _id: { $in: eventIds }, status: EventStatus.PUBLISHED }).select('_id').lean();
  const published = new Set(publishedDocs.map((e) => String(e._id)));

  // ---- 4. unwindowed minimums, per pair ----
  const allCommunities = await Community.find({ eventId: { $in: eventIds } }).select('eventId').lean();
  const eventIdByCommunityAll = new Map(allCommunities.map((c) => [String(c._id), String(c.eventId)]));
  const allMemberships = allCommunities.length
    ? await Membership.find({
        buyerId: { $in: buyerIds },
        communityId: { $in: allCommunities.map((c) => c._id) },
        bannedAt: { $exists: false },
      }).select('buyerId communityId createdAt').lean()
    : [];

  const allBuyers = await Buyer.find({ _id: { $in: buyerIds } }).select('phone').lean();
  const buyerIdByPhoneAll = new Map(allBuyers.map((b) => [b.phone, String(b._id)]));
  const allPhones = allBuyers.map((b) => b.phone);
  const allTickets = allPhones.length
    ? await Ticket.find({
        customerPhone: { $in: allPhones },
        eventId: { $in: eventIds },
        status: { $in: LIVE },
      }).select('customerPhone eventId createdAt').lean()
    : [];

  const earliest = new Map<string, number>();
  const note = (buyerId: string, eventId: string, at: Date) => {
    const key = pairKey(buyerId, eventId);
    const ms = at.getTime();
    const seen = earliest.get(key);
    if (seen === undefined || ms < seen) earliest.set(key, ms);
  };
  for (const m of allMemberships) {
    const eventId = eventIdByCommunityAll.get(String(m.communityId));
    if (eventId) note(String(m.buyerId), eventId, m.createdAt as Date);
  }
  for (const t of allTickets) {
    const buyerId = t.customerPhone ? buyerIdByPhoneAll.get(t.customerPhone) : undefined;
    if (buyerId) note(buyerId, String(t.eventId), t.createdAt as Date);
  }

  // ---- 5. emit ----
  const emitted = new Set<string>();
  const out: ActivityCandidate[] = [];
  for (const r of rows) {
    if (!published.has(r.eventId)) continue;
    const key = pairKey(r.buyerId, r.eventId);
    if (emitted.has(key)) continue;
    // A twin row is strictly older — it owns this pair, on every page.
    if (earliest.get(key) !== r.at.getTime()) continue;
    emitted.add(key);
    out.push({
      type: 'going',
      sourceId: r.sourceId,
      sortAt: r.at,
      actor: { kind: 'buyer', id: r.buyerId },
      target: { kind: 'event', id: r.eventId },
    });
  }
  // Withhold anything below the completeness boundary (see comment above):
  // we'd rather defer a row to a later page than let the caller's watermark
  // skip past one we haven't actually resolved yet.
  const complete = boundary === undefined ? out : out.filter((c) => c.sortAt.getTime() >= boundary);

  return complete.sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());
}
