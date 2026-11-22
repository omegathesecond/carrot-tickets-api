import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { Buyer } from '@models/buyer.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';
import { currentWeekendWindow } from '@utils/weekendWindow.util';
import { normalizePhone } from '@utils/phone.util';

/** Public social proof uses the same membership and live-ticket definition as GoingService. */
export async function weekendAttendance(now = new Date()) {
  const { start, end } = currentWeekendWindow(now);
  const events = await Event.find({ status: { $in: [EventStatus.PUBLISHED, EventStatus.ONGOING] }, eventDate: { $lte: end }, endTime: { $gte: start } }).select('name eventDate endTime posterUrl').lean();
  const ids = events.map(e => e._id);
  if (!ids.length) return [];
  const [communities, tickets] = await Promise.all([
    Community.find({ eventId: { $in: ids } }).select('eventId').lean(),
    Ticket.find({ eventId: { $in: ids }, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }).select('eventId buyerId customerPhone customerEmail saleId purchasedBy').lean(),
  ]);
  const memberships = await Membership.find({ communityId: { $in: communities.map(c => c._id) }, buyerId: { $exists: true }, bannedAt: { $exists: false } }).select('communityId buyerId').lean();
  const buyerIds = [...memberships.map(m => m.buyerId), ...tickets.map(t => t.buyerId)].filter(Boolean);
  const phones = tickets.map(t => t.customerPhone).filter((p): p is string => Boolean(p)).map(normalizePhone);
  const emails = tickets.map(t => t.customerEmail?.toLowerCase()).filter((e): e is string => Boolean(e));
  const buyers = await Buyer.find({ $or: [{ _id: { $in: buyerIds } }, { phone: { $in: phones } }, { email: { $in: emails } }] }).select('name username avatarUrl phone email').lean();
  const byId = new Map(buyers.map(b => [String(b._id), b]));
  const byPhone = new Map(buyers.filter(b => b.phone).map(b => [normalizePhone(b.phone!), b]));
  const byEmail = new Map(buyers.filter(b => b.email).map(b => [b.email!.toLowerCase(), b]));
  const eventByCommunity = new Map(communities.map(c => [String(c._id), String(c.eventId)]));
  // Join identities per event, including anonymous purchasers, without exposing their contact details.
  const groups = new Map<string, Map<string, Set<string>>>();
  const add = (eventId: string, keys: string[]) => {
    if (!groups.has(eventId)) groups.set(eventId, new Map());
    const index = groups.get(eventId)!;
    const merged = new Set(keys);
    for (const key of keys) for (const member of index.get(key) ?? []) merged.add(member);
    for (const key of merged) index.set(key, merged);
  };
  for (const m of memberships) {
    const eventId = eventByCommunity.get(String(m.communityId));
    if (eventId && m.buyerId && byId.has(String(m.buyerId))) add(eventId, [`buyer:${m.buyerId}`]);
  }
  for (const t of tickets) {
    const phone = t.customerPhone ? normalizePhone(t.customerPhone) : '';
    const email = t.customerEmail?.trim().toLowerCase() ?? '';
    const matches = [t.buyerId && byId.get(String(t.buyerId)), phone && byPhone.get(phone), email && byEmail.get(email)];
    const keys: string[] = [];
    for (const buyer of matches) if (buyer) keys.push(`buyer:${buyer._id}`);
    if (t.buyerId) keys.push(`buyer:${t.buyerId}`);
    if (phone) keys.push(`phone:${phone}`);
    if (email) keys.push(`email:${email}`);
    if (t.purchasedBy) keys.push(`purchaser:${t.purchasedBy}`);
    if (!keys.length && t.saleId) keys.push(`sale:${t.saleId}`);
    if (!keys.length) keys.push(`ticket:${t._id}`);
    add(String(t.eventId), keys);
  }
  return events.flatMap(event => {
    const identities = new Set(groups.get(String(event._id))?.values() ?? []);
    const people = [...identities].flatMap(identity => {
      const buyerKey = [...identity].find(key => key.startsWith('buyer:') && byId.has(key.slice(6)));
      const b = buyerKey ? byId.get(buyerKey.slice(6)) : undefined;
      return b ? [{ id: String(b._id), name: b.name ?? null, username: b.username ?? null, avatarUrl: b.avatarUrl ?? null }] : [];
    });
    return identities.size ? [{ id: String(event._id), name: event.name, eventDate: event.eventDate, posterUrl: event.posterUrl ?? null, count: identities.size, attendees: people }] : [];
  });
}
