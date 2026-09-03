import { TicketReservation } from '@models/ticketReservation.model';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

async function adjustReserved(eventId: unknown, ticketTypeId: string, delta: number): Promise<void> {
  const event = await Event.findById(eventId);
  if (!event) throw new Error(`adjustReserved: event ${eventId} / ticketType ${ticketTypeId} not found`);
  const tt = event.ticketTypes.find((t) => t._id?.toString() === ticketTypeId);
  if (!tt) throw new Error(`adjustReserved: event ${eventId} / ticketType ${ticketTypeId} not found`);
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

  /**
   * Rails whose lapsed PENDING sale must NOT be auto-failed by the sweep.
   *
   * Note what "recoverable" actually means here: this sweep fails a lapsed sale
   * WITHOUT asking the provider. Peach, DeltaPay and MoMo are safe only because
   * their reconcile jobs run on a shorter interval than the hold, so a paid sale
   * is normally resolved before the sweep reaches it. Once a sale is FAILED,
   * every finalizer early-returns 'failed' — there is no path back for any rail.
   *
   * Two rails are therefore carved out entirely:
   *
   * - YOCO publishes NO status-query endpoint, so a late signed webhook is the
   *   only thing that can ever mint it.
   * - YEBOPAY can be asked, but its webhook delivery has NO automatic retry, so
   *   losing the race is not a rare event with a safety net behind it — it is
   *   one dropped POST away. Its own checkout lifecycle is the better authority:
   *   reconcilePendingYeboPaySales polls, and fails the sale only once YeboPay
   *   itself reports EXPIRED or CANCELLED. An abandoned sale therefore stays
   *   PENDING locally until YeboPay expires the checkout, which is slower but
   *   never wrong.
   *
   * The inventory hold is still released for these rails — only the sale status
   * is left alone, so there is no oversell risk from the delay.
   */
  private static readonly NO_AUTO_FAIL_METHODS: readonly PaymentMethod[] = [
    PaymentMethod.YOCO,
    PaymentMethod.YEBOPAY,
  ];

  static async sweepExpired(): Promise<number> {
    const lapsed = await TicketReservation.find({ status: 'held', expiresAt: { $lt: new Date() } });
    let n = 0;
    for (const r of lapsed) {
      try {
        await adjustReserved(r.eventId, r.ticketTypeId, -r.quantity);
        r.status = 'released';
        await r.save();
        await TicketSale.updateOne(
          {
            _id: r.saleId,
            paymentStatus: PaymentStatus.PENDING,
            paymentMethod: { $nin: this.NO_AUTO_FAIL_METHODS },
          },
          { $set: { paymentStatus: PaymentStatus.FAILED } }
        );
        n++;
      } catch (err) {
        console.error(`[reservation-sweep] failed for sale ${r.saleId}`, err);
      }
    }
    return n;
  }
}
