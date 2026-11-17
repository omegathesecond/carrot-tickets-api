import { createHash } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { Update } from '@models/update.model';

/** One ordinary post per photo; stable IDs make repeated applications and backfills idempotent. */
export async function publishApplicationPhotos(authorType: 'buyer' | 'vendor', authorId: Types.ObjectId, photos: string[], createdAt: Date, session?: ClientSession) {
  for (const url of photos) {
    const id = new Types.ObjectId(createHash('sha256').update(`application-photo:${authorType}:${authorId}:${url}`).digest('hex').slice(0, 24));
    await Update.updateOne({ _id: id }, { $setOnInsert: {
      authorType, authorId, kind: 'image', caption: '',
      media: [{ rawKey: decodeURIComponent(new URL(url).pathname.slice(1)), status: 'ready', image: { url, width: 0, height: 0 } }],
      createdAt, updatedAt: createdAt,
    } }, { upsert: true, session, timestamps: false, runValidators: true });
  }
}
