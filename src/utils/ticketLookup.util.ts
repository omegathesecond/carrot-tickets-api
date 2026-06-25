// api/src/utils/ticketLookup.util.ts
import { ClientSession } from 'mongoose';
import { Ticket } from '@models/ticket.model';
import { ITicket } from '@interfaces/ticket.interface';
import { normalizeTicketCode } from '@utils/ticketCode.util';

/**
 * Resolve a ticket from raw operator/QR input. Tries an exact match first
 * (covers verbatim legacy `TKT-…` ids), then a normalized match (covers new
 * short codes typed with dashes/spaces or lowercase). Returns null if neither
 * hits — callers surface "Ticket not found" loudly.
 */
export async function findTicketByCode(
  input: string,
  session?: ClientSession
): Promise<ITicket | null> {
  const raw = (input || '').trim();
  if (!raw) return null;

  const exact = await Ticket.findOne({ ticketId: raw }).session(session ?? null);
  if (exact) return exact;

  const normalized = normalizeTicketCode(raw);
  if (!normalized || normalized === raw) return null;
  return Ticket.findOne({ ticketId: normalized }).session(session ?? null);
}
