/**
 * Wrap each Update's single `media` sub-document into a length-1 array, matching
 * the new `media: UpdateMedia[]` schema. Idempotent — only touches docs whose
 * `media` is still an object (not already an array). Run ONCE per database (dev
 * and prod) with that DB's MONGODB_URI, BEFORE the new api revision serves.
 *
 * Usage: MONGODB_URI='<uri>' npm run migrate:update-media-array
 */
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { getDatabaseURI } from '../src/config/database.config';

// Selects docs whose `media` field's own BSON type is exactly "object" (the
// old single-doc shape). Deliberately uses the $expr/aggregation form of
// $type rather than the query-operator form: the query-operator `{ media: {
// $type: 'object' } }` ALSO matches when `media` is an ARRAY containing an
// object element (Mongo's query $type traverses into array elements), which
// would re-match already-migrated `[UpdateMedia]` docs and double-wrap them
// on every re-run. `{ $type: '$media' }` inside $expr reports the field's
// own top-level type ("object" | "array" | "missing" | "null" | ...) with no
// element traversal, so already-migrated docs are correctly excluded.
export async function migrateMediaToArray(db: Db): Promise<{ migrated: number }> {
  const res = await db
    .collection('updates')
    .updateMany({ $expr: { $eq: [{ $type: '$media' }, 'object'] } }, [
      { $set: { media: ['$media'] } },
    ]);
  return { migrated: res.modifiedCount };
}

async function main(): Promise<void> {
  await mongoose.connect(getDatabaseURI());
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect');
  console.log(`Connected to ${mongoose.connection.name}`);

  const { migrated } = await migrateMediaToArray(db);
  console.log(`Migrated ${migrated} update(s) to media[].`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
