/**
 * One-time index migration for the `reviews` collection (Task E1).
 *
 * BACKGROUND: `Review` used to require `eventId` and enforced a single
 * `{ eventId: 1, buyerId: 1 }` unique index. Service businesses (Vendor
 * operatorType:'services') sell no tickets, so a review of one has no
 * eventId — two service reviews from the same buyer to two DIFFERENT
 * vendors would both carry `eventId: null` and collide on that index.
 *
 * FIX (review.model.ts): `eventId` is now optional, and the old index is
 * replaced by two disjoint PARTIAL unique indexes:
 *   - eventId_1_buyerId_1        (partial: eventId exists)  — unique per event review
 *   - vendorId_1_buyerId_1       (partial: eventId is null) — unique per service review
 * Mongoose never rewrites an EXISTING index's options in place, so the old
 * `eventId_1_buyerId_1` (non-partial) has to be dropped explicitly before
 * `Review.syncIndexes()` can (re)create the partial version under the same
 * name — otherwise syncIndexes sees a name collision with different options
 * and throws.
 *
 * Safe to re-run: dropIndex is wrapped so "index not found" (server code 27,
 * IndexNotFound) is ignored, and syncIndexes() is idempotent. Run against
 * BOTH dev and prod DBs.
 *
 * IMPORTANT: connects with `autoIndex: false`. Mongoose's default autoIndex
 * kicks off a BACKGROUND createIndexes call the moment the model is
 * registered on an open connection — racing our explicit drop-then-sync
 * order. If that background build wins the race while the legacy
 * non-partial `eventId_1_buyerId_1` still exists in prod, it throws
 * IndexKeySpecsConflict trying to create the new partial index under the
 * same name (verified against a real mongod). Disabling autoIndex here
 * makes `syncIndexes()` the only thing that ever builds indexes.
 *
 *   MONGODB_URI='...' npm run migrate:review-indexes
 */
import mongoose from 'mongoose';
import { Review } from '@models/review.model';

// Indexes whose OPTIONS changed over time and therefore must be dropped before
// syncIndexes() can recreate them under the same name (Mongoose never rewrites
// an existing index's options in place — a name collision with different
// options throws IndexKeySpecsConflict):
//   - eventId_1_buyerId_1   was a plain unique index; now partial (eventId exists)
//   - vendorId_1_buyerId_1  partial widened from {eventId:null} to also require
//                           buyerId:$exists, so organizer service reviews (no
//                           buyerId) share the {vendorId, reviewerVendorId}
//                           index instead of colliding on this one.
const LEGACY_INDEX_NAMES = ['eventId_1_buyerId_1', 'vendorId_1_buyerId_1'];
const INDEX_NOT_FOUND_CODE = 27; // MongoDB server error code: IndexNotFound

export async function migrateReviewIndexes(): Promise<void> {
  const col = mongoose.connection.collection('reviews');

  for (const name of LEGACY_INDEX_NAMES) {
    try {
      await col.dropIndex(name);
      console.log(`[migrate-review-indexes] dropped legacy index "${name}"`);
    } catch (err: any) {
      if (err?.code === INDEX_NOT_FOUND_CODE || err?.codeName === 'IndexNotFound') {
        console.log(`[migrate-review-indexes] legacy index "${name}" already absent — skipping drop`);
      } else {
        throw err;
      }
    }
  }

  await Review.syncIndexes();

  const after = await col.indexes();
  console.log('[migrate-review-indexes] resulting indexes on reviews:');
  for (const idx of after) {
    console.log(`  - ${idx.name}: key=${JSON.stringify(idx.key)}${idx.unique ? ' unique' : ''}${idx.partialFilterExpression ? ` partial=${JSON.stringify(idx.partialFilterExpression)}` : ''}`);
  }
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri, { autoIndex: false });
    console.log('[migrate-review-indexes] connected (autoIndex disabled)');
    await migrateReviewIndexes();
    await mongoose.disconnect();
    console.log('[migrate-review-indexes] done');
  })().catch((err) => {
    console.error('[migrate-review-indexes] failed:', err);
    process.exit(1);
  });
}
