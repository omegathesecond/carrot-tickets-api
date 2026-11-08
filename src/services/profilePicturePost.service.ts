import { createHash } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { Update } from '@models/update.model';

/** Avatar keys have always included the upload's millisecond timestamp. Do not
 * use Buyer.updatedAt: unrelated account changes also update that field. */
export function profilePictureUploadedAt(url: string): Date | undefined {
  const match = new URL(url).pathname.match(/\/avatar\/(\d{13})-avatar\.[^/]+$/);
  if (!match) return undefined;
  const date = new Date(Number(match[1]));
  return date.getTime() > 0 && date.getTime() <= Date.now() ? date : undefined;
}

/** Uses the built-in unique _id index, so reruns and concurrent backfills need
 * no new index rollout. Removed posts stay removed; we never overwrite a post.
 * Width/height 0 follows the existing ready-image update convention. */
export async function publishProfilePicture(
  buyerId: Types.ObjectId, url: string, session?: ClientSession,
): Promise<boolean> {
  const existing = await Update.exists({
    authorType: 'buyer', authorId: buyerId, 'media.image.url': url,
  }).session(session ?? null);
  if (existing) return false;
  const id = new Types.ObjectId(createHash('sha256')
    .update(`profile-picture:${buyerId}:${url}`).digest('hex').slice(0, 24));
  const createdAt = profilePictureUploadedAt(url) ?? new Date();
  const result = await Update.updateOne({ _id: id }, { $setOnInsert: {
    authorType: 'buyer', authorId: buyerId, kind: 'image', caption: '',
    media: [{ rawKey: decodeURIComponent(new URL(url).pathname.slice(1)), status: 'ready',
      image: { url, width: 0, height: 0 } }],
    createdAt, updatedAt: createdAt,
  } }, { upsert: true, session, timestamps: false, runValidators: true });
  return result.upsertedCount === 1;
}
