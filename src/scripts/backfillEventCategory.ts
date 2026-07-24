import mongoose from 'mongoose';
import { Event } from '@models/event.model';

/** One-time, idempotent: events written before `category` existed become 'Other'
 *  (organizers re-tag from the dashboard). Never inferred from the name. */
export async function backfillEventCategory(): Promise<{ updated: number }> {
  const res = await Event.updateMany(
    { category: { $exists: false } },
    { $set: { category: 'Other' } },
  );
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillEventCategory] done:', await backfillEventCategory());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillEventCategory] failed:', err);
    process.exit(1);
  });
}
