import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { normalizePhone } from '@utils/phone.util';

/**
 * A buyer "holds a ticket" for an event when a ticket document carries their
 * normalized phone and is in a holder state. SOLD covers pre-event holders;
 * CHECKED_IN keeps access after the gate scan (mid-festival chat must not
 * lock out people who already entered). REFUNDED/CANCELLED lose access.
 *
 * This is the SAME phone-match contract as "My Tickets" — do not diverge.
 */
export async function isTicketHolder(eventId: string, rawPhone: string): Promise<boolean> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return false;
  const holder = await Ticket.exists({
    eventId,
    customerPhone: phone,
    status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
  });
  return holder !== null;
}

/**
 * Mongo filter clause matching any ticket that belongs to `buyer`, by whichever
 * handles they have. buyerId is the canonical owner link (stamped on new
 * purchases); customerPhone / customerEmail cover tickets bought before buyerId
 * existed or under a bare handle. Compose with an eventId + status filter.
 *
 * IMPORTANT: only handles the buyer actually has are added — never emit
 * `{ customerPhone: undefined }` (that matches phone-less tickets); same
 * reasoning applies to buyerId, so `_id` is optional here too (Mongoose's
 * Document typing has `_id` as optional even though a persisted buyer always
 * has one) and is only added to the clause when present.
 *
 * A buyer with NONE of the three handles produces an EMPTY array. Composed
 * as `$or: []`, MongoDB treats that as vacuously true — matching every
 * document — which would be a silent auth-bypass (a degenerate buyer
 * "holding" every ticket for every event). Fail loud instead: this should
 * never happen for a real buyer (the schema requires phone or email, and a
 * persisted document always has an _id), so a caller hitting this is a bug,
 * not a valid state to filter past.
 */
export function buyerTicketOr(buyer: { _id?: unknown; phone?: string; email?: string }): Record<string, unknown>[] {
  const or: Record<string, unknown>[] = [];
  if (buyer._id) or.push({ buyerId: buyer._id });
  if (buyer.phone) or.push({ customerPhone: normalizePhone(buyer.phone) });
  if (buyer.email) or.push({ customerEmail: buyer.email.toLowerCase() });
  if (or.length === 0) throw new Error('buyerTicketOr: buyer has no _id/phone/email to match on');
  return or;
}

/** Buyer-aware live-ticket-holder check (SOLD or CHECKED_IN), matching by id/phone/email. */
export async function isTicketHolderForBuyer(
  eventId: string,
  buyer: { _id?: unknown; phone?: string; email?: string },
): Promise<boolean> {
  const holder = await Ticket.exists({
    eventId,
    status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
    $or: buyerTicketOr(buyer),
  });
  return holder !== null;
}
