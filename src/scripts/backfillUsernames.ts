/** Run against each target database before delivering the username release.
 * Renews inactive buyers too; lazy own-profile assignment cannot do that.
 * MONGODB_URI=<target> npm run backfill:usernames
 */
import mongoose from 'mongoose';
import { Buyer } from '@models/buyer.model';
import {
  generateUniqueUsername, hasLegacyGeneratedUsername, LEGACY_GENERATED_USERNAME_PATTERN,
} from '@utils/username.util';

export async function backfillUsernames(): Promise<{ updated: number }> {
  let updated = 0;
  const cursor = Buyer.find({
    username: LEGACY_GENERATED_USERNAME_PATTERN,
    usernameCustomizedAt: null,
  }).cursor();
  try {
    for await (const buyer of cursor) {
      if (!hasLegacyGeneratedUsername(buyer)) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const username = await generateUniqueUsername(buyer.name);
        try {
          // Do not overwrite a handle/name customized after this cursor read.
          const result = await Buyer.updateOne({
            _id: buyer._id, username: buyer.username,
            name: buyer.name ?? null, usernameCustomizedAt: null,
          }, { $set: { username } }, { runValidators: true });
          updated += result.modifiedCount;
          break;
        } catch (error) {
          if ((error as { code?: number }).code !== 11000 || attempt === 2) throw error;
        }
      }
    }
  } finally {
    await cursor.close();
  }
  return { updated };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    try {
      await mongoose.connect(uri);
      console.log('[backfillUsernames] done:', await backfillUsernames());
    } finally {
      await mongoose.disconnect();
    }
  })().catch((error) => {
    console.error('[backfillUsernames] failed:', error);
    process.exitCode = 1;
  });
}
