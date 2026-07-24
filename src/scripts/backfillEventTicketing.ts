import mongoose from 'mongoose';
import { Event } from '@models/event.model';

/** One-time, idempotent: every event written before `ticketing` existed sells
 *  via Carrot. Fills only missing fields. */
export async function backfillEventTicketing(): Promise<{ updated: number }> {
  const res = await Event.updateMany(
    { ticketing: { $exists: false } },
    { $set: { ticketing: 'carrot' } },
  );
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillEventTicketing] done:', await backfillEventTicketing());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillEventTicketing] failed:', err);
    process.exit(1);
  });
}
