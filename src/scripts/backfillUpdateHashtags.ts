import mongoose from 'mongoose';
import { Update } from '@models/update.model';
import { extractHashtags } from '@utils/hashtags.util';

/** One-time, idempotent: updates written before `hashtags` existed (or with an
 *  empty array) get hashtags derived from their existing caption. Since the
 *  value is per-doc (derived from caption text), this can't be a single
 *  updateMany — it cursors through candidates and bulk-writes per-doc sets. */
export async function backfillUpdateHashtags(): Promise<{ updated: number }> {
  const cursor = Update.find({
    caption: /#/,
    $or: [{ hashtags: { $exists: false } }, { hashtags: { $size: 0 } }],
  })
    .select('caption hashtags')
    .cursor();

  const ops: mongoose.mongo.AnyBulkWriteOperation[] = [];
  for await (const doc of cursor) {
    const hashtags = extractHashtags(doc.caption);
    if (hashtags.length === 0) continue;
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { hashtags } } } });
  }

  if (ops.length === 0) return { updated: 0 };
  const res = await Update.bulkWrite(ops);
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillUpdateHashtags] done:', await backfillUpdateHashtags());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillUpdateHashtags] failed:', err);
    process.exit(1);
  });
}
