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
