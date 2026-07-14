import mongoose from 'mongoose';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';

/** One-time, idempotent: every vendor written before operatorType existed is an
 *  event organizer (transport launched 2026-07-13). Fills only missing fields. */
export async function backfillOperatorType(): Promise<{ updated: number }> {
  const res = await Vendor.updateMany(
    { operatorType: { $exists: false } },
    { $set: { operatorType: OperatorType.EVENTS } },
  );
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillOperatorType] done:', await backfillOperatorType());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillOperatorType] failed:', err);
    process.exit(1);
  });
}
