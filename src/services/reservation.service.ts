import { TicketReservation } from '@models/ticketReservation.model';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';

async function adjustReserved(eventId: unknown, ticketTypeId: string, delta: number): Promise<void> {
  const event = await Event.findById(eventId);
  if (!event) return;
  const tt = event.ticketTypes.find((t) => t._id?.toString() === ticketTypeId);
  if (!tt) return;
  tt.reserved = Math.max(0, (tt.reserved || 0) + delta);
  await event.save(); // pre-save hook recomputes available
}

export class ReservationService {
  static async reserve(p: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    saleId: string;
    ttlMs: number;
  }): Promise<{ reservationId: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + p.ttlMs);
    await adjustReserved(p.eventId, p.ticketTypeId, +p.quantity);
    const r = await TicketReservation.create({
      eventId: p.eventId,
      ticketTypeId: p.ticketTypeId,
      quantity: p.quantity,
      saleId: p.saleId,
      expiresAt,
      status: 'held',
    });
    return { reservationId: r._id.toString(), expiresAt };
  }

  static async confirm(saleId: string): Promise<void> {
    const r = await TicketReservation.findOne({ saleId, status: 'held' });
    if (!r) return;
    await adjustReserved(r.eventId, r.ticketTypeId, -r.quantity);
    r.status = 'confirmed';
    await r.save();
  }

  static async release(saleId: string): Promise<void> {
    const r = await TicketReservation.findOne({ saleId, status: 'held' });
    if (!r) return;
    await adjustReserved(r.eventId, r.ticketTypeId, -r.quantity);
    r.status = 'released';
    await r.save();
  }

  static async sweepExpired(): Promise<number> {
    const lapsed = await TicketReservation.find({ status: 'held', expiresAt: { $lt: new Date() } });
    let n = 0;
    for (const r of lapsed) {
      await adjustReserved(r.eventId, r.ticketTypeId, -r.quantity);
      r.status = 'released';
      await r.save();
      await TicketSale.updateOne(
        { _id: r.saleId, paymentStatus: PaymentStatus.PENDING },
        { $set: { paymentStatus: PaymentStatus.FAILED } }
      );
      n++;
    }
    return n;
  }
}
