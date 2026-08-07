/**
 * Membership polymorphic-index migration.
 *
 * Membership went from buyer-only (`buyerId` required) to polymorphic
 * (`buyerId` XOR `vendorId`, so a brand can join a community too). The old
 * `{ buyerId: 1, communityId: 1 }` PLAIN unique index must become PARTIAL, or:
 *   1. a vendor row (buyerId absent → indexed as null) would collide with the
 *      next vendor joining the same community on `(null, communityId)`; and
 *   2. the app's autoIndex can't replace it — same index name, different
 *      options ⇒ "existing index has the same name" and the new index is
 *      silently not built.
 *
 * This script (idempotent) drops the stale plain index if present and creates
 * the two partial unique indexes the new model declares. Run it ONCE per
 * database (dev and prod) with that database's MONGODB_URI, BEFORE the new API
 * revision serves traffic.
 *
 * Usage:
 *   MONGODB_URI='<uri>' npx ts-node scripts/migrate-membership-polymorphic-indexes.ts
 */
import mongoose from 'mongoose';
import { getDatabaseURI } from '../src/config/database.config';

const BUYER_IDX = 'buyerId_1_communityId_1';
const VENDOR_IDX = 'vendorId_1_communityId_1';

async function main(): Promise<void> {
  const uri = getDatabaseURI();
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect');
  console.log(`Connected to ${mongoose.connection.name}`);

  const coll = db.collection('memberships');
  const existing = await coll.indexes();
  const byName = new Map(existing.map((i) => [i.name, i]));

  // 1. Drop the stale PLAIN buyer index (keep a correctly-partial one as-is).
  const buyer = byName.get(BUYER_IDX);
  if (buyer && !buyer.partialFilterExpression) {
    console.log(`Dropping stale non-partial index ${BUYER_IDX} …`);
    await coll.dropIndex(BUYER_IDX);
  } else if (buyer) {
    console.log(`${BUYER_IDX} is already partial — leaving it.`);
  } else {
    console.log(`${BUYER_IDX} not present — nothing to drop.`);
  }

  // 2. Create the two partial unique indexes (createIndex is idempotent when
  //    an identical index already exists).
  console.log(`Ensuring partial unique ${BUYER_IDX} …`);
  await coll.createIndex(
    { buyerId: 1, communityId: 1 },
    { unique: true, partialFilterExpression: { buyerId: { $exists: true } }, name: BUYER_IDX }
  );
  console.log(`Ensuring partial unique ${VENDOR_IDX} …`);
  await coll.createIndex(
    { vendorId: 1, communityId: 1 },
    { unique: true, partialFilterExpression: { vendorId: { $exists: true } }, name: VENDOR_IDX }
  );

  const after = (await coll.indexes()).map((i) => i.name);
  console.log('Indexes now:', after.join(', '));
  await mongoose.connection.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
