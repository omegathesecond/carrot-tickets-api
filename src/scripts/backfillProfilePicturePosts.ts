import mongoose from 'mongoose';
import { Buyer } from '@models/buyer.model';
import { publishProfilePicture } from '@services/profilePicturePost.service';

/** Explicit one-time operation, never run on startup. Safe to resume/rerun. */
export async function backfillProfilePicturePosts(): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for await (const buyer of Buyer.find({ avatarUrl: { $type: 'string', $nin: ['', null] } })
    .select('avatarUrl').cursor()) {
    if (await publishProfilePicture(buyer._id, buyer.avatarUrl!)) created++;
    else skipped++;
  }
  return { created, skipped };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    try {
      await mongoose.connect(uri);
      console.log('[backfillProfilePicturePosts]', await backfillProfilePicturePosts());
    } finally {
      await mongoose.disconnect();
    }
  })().catch((error) => {
    console.error('[backfillProfilePicturePosts] failed:', error);
    process.exitCode = 1;
  });
}
