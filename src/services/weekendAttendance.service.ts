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
    Ticket.find({ eventId: { $in: ids }, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }).select('eventId buyerId customerPhone customerEmail').lean(),
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
  const attendees = new Map<string, Set<string>>();
  const add = (eventId: string, buyerId: string) => { if (!byId.has(buyerId)) return; if (!attendees.has(eventId)) attendees.set(eventId, new Set()); attendees.get(eventId)!.add(buyerId); };
  for (const m of memberships) { const eventId = eventByCommunity.get(String(m.communityId)); if (eventId && m.buyerId) add(eventId, String(m.buyerId)); }
  for (const t of tickets) {
    const matches = [t.buyerId && byId.get(String(t.buyerId)), t.customerPhone && byPhone.get(normalizePhone(t.customerPhone)), t.customerEmail && byEmail.get(t.customerEmail.toLowerCase())];
    for (const buyer of matches) if (buyer) add(String(t.eventId), String(buyer._id));
  }
  return events.flatMap(event => {
    const people = [...(attendees.get(String(event._id)) ?? [])].map(id => byId.get(id)!).map(b => ({ id: String(b._id), name: b.name ?? null, username: b.username ?? null, avatarUrl: b.avatarUrl ?? null }));
    return people.length ? [{ id: String(event._id), name: event.name, eventDate: event.eventDate, posterUrl: event.posterUrl ?? null, count: people.length, attendees: people }] : [];
  });
}
