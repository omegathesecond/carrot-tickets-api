import mongoose from 'mongoose';
import { Ticket } from '../models/ticket.model';
import { TicketSale } from '../models/ticketSale.model';
import { TicketStatus } from '../interfaces/ticket.interface';

/**
 * One-time, idempotent backfill of `TicketSale.refundedQuantity` /
 * `refundedAmount` from the tickets that were refunded before the sale
 * carried those counters.
 *
 * WHY: TicketService.refundTicket flips a ticket to REFUNDED and now also
 * records it on the parent sale, and every analytics revenue / tickets-sold
 * figure reads `totalAmount − refundedAmount` / `quantity − refundedQuantity`
 * (see analytics.service NET_SALE_AMOUNT). Sales refunded before that change
 * have no counters, so their refunded money still shows as collected until
 * this runs. It recomputes the counters from the Ticket docs — the source of
 * truth for what was refunded — so it also corrects any drift.
 *
 * Run: `npm run backfill:sale-refunds` with MONGODB_URI pointing at the target
 * database (dev, then prod). Safe to re-run.
 */
export async function backfillSaleRefunds(): Promise<{ salesUpdated: number; refundedTickets: number }> {
  const refunded = await Ticket.aggregate<{ _id: mongoose.Types.ObjectId; quantity: number; amount: number }>([
    { $match: { status: TicketStatus.REFUNDED, saleId: { $ne: null } } },
    { $group: { _id: '$saleId', quantity: { $sum: 1 }, amount: { $sum: '$price' } } }
  ]);
  if (refunded.length === 0) return { salesUpdated: 0, refundedTickets: 0 };

  const res = await TicketSale.bulkWrite(refunded.map(r => ({
    updateOne: {
      // Only touch sales whose counters are actually wrong, so a re-run is a no-op.
      filter: { _id: r._id, $or: [{ refundedQuantity: { $ne: r.quantity } }, { refundedAmount: { $ne: r.amount } }] },
      update: { $set: { refundedQuantity: r.quantity, refundedAmount: r.amount } }
    }
  })));

  return {
    salesUpdated: res.modifiedCount,
    refundedTickets: refunded.reduce((sum, r) => sum + r.quantity, 0)
  };
}

// Allow running directly: `ts-node -r tsconfig-paths/register src/scripts/backfillSaleRefunds.ts`
if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    const counts = await backfillSaleRefunds();
    console.log('[backfillSaleRefunds] done:', counts);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillSaleRefunds] failed:', err);
    process.exit(1);
  });
}
