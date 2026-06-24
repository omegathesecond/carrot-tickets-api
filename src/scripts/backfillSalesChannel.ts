/**
 * One-time, idempotent backfill of TicketSale.channel for docs written before
 * the channel field existed. Matches only docs with no channel, so re-running
 * is safe.
 *
 * Heuristic:
 *   - soldByType ResellerOperator           -> reseller_pos
 *   - else customerUserId set (app buyer)    -> online   (best guess)
 *   - else                                   -> box_office
 *
 * LIMITATION: historical online *web* sales that carry no customerUserId cannot
 * be told apart from box-office and become box_office. Going forward this
 * ambiguity does not exist — channel is set correctly at sale time.
 */
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { SalesChannel } from '@interfaces/ticket.interface';

export async function backfillSalesChannel(): Promise<{
  reseller_pos: number; online: number; box_office: number;
}> {
  const missing = { channel: { $exists: false } };

  const reseller = await TicketSale.updateMany(
    { ...missing, soldByType: 'ResellerOperator' },
    { $set: { channel: SalesChannel.RESELLER_POS } },
  );
  const online = await TicketSale.updateMany(
    { ...missing, customerUserId: { $exists: true, $ne: null } },
    { $set: { channel: SalesChannel.ONLINE } },
  );
  const boxOffice = await TicketSale.updateMany(
    { ...missing },
    { $set: { channel: SalesChannel.BOX_OFFICE } },
  );

  return {
    reseller_pos: reseller.modifiedCount,
    online: online.modifiedCount,
    box_office: boxOffice.modifiedCount,
  };
}

// Allow running directly: `ts-node -r tsconfig-paths/register src/scripts/backfillSalesChannel.ts`
if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    const counts = await backfillSalesChannel();
    console.log('[backfillSalesChannel] done:', counts);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillSalesChannel] failed:', err);
    process.exit(1);
  });
}
