/**
 * One-time index migration for the `weekendstatuses` collection.
 *
 * BACKGROUND: `WeekendStatus.buyerId` used to be `unique: true` — back when
 * the collection held only the singular "My Weekend" profile-widget status
 * (one row per buyer). The "+Add" composer (weekendStatus.model.ts) added a
 * second `plan_post` row kind — many per buyer, no longer upserted — and
 * dropped `unique: true` from the schema. Mongoose never drops an existing
 * index just because the schema stops declaring it, so the legacy plain
 * unique `buyerId_1` index stayed live on every already-provisioned DB
 * (dev/prod) and kept rejecting a buyer's SECOND row with
 * `E11000 duplicate key error ... index: buyerId_1` — whether that second
 * row is a second `plan_post` or even a `profile_widget` upsert racing a
 * plan create.
 *
 * FIX (weekendStatus.model.ts): the legacy `buyerId_1` index is dropped and
 * replaced by the two indexes the current schema actually declares —
 * `buyerId_1_source_1_activeUntil_1` (plain) and the partial
 * `buyerId_1_clientRequestId_1` (unique, idempotent create only).
 *
 * Safe to re-run: dropIndex ignores "index not found" (server code 27) and
 * syncIndexes() is idempotent. Runs at boot (see app.ts) so an environment
 * nobody remembered to run it against (e.g. dev) self-heals on its next
 * deploy rather than staying broken indefinitely.
 *
 * IMPORTANT: connects with `autoIndex: false`. Mongoose's default autoIndex
 * kicks off a BACKGROUND createIndexes call the moment the model is
 * registered on an open connection — racing our explicit drop-then-sync
 * order (see migrate-review-indexes.ts for the same race verified against a
 * real mongod). Disabling autoIndex here makes `syncIndexes()` the only
 * thing that ever builds indexes for this collection outside tests —
 * weekendStatus.model.ts turns its own autoIndex off outside NODE_ENV==='test'
 * for the same reason.
 *
 *   MONGODB_URI='...' npm run migrate:weekend-indexes
 */
import mongoose from 'mongoose';
import { WeekendStatus } from '@models/weekendStatus.model';

const LEGACY_INDEX_NAMES = ['buyerId_1'];
const INDEX_NOT_FOUND_CODE = 27; // MongoDB server error code: IndexNotFound

export async function migrateWeekendIndexes(): Promise<void> {
  const col = mongoose.connection.collection('weekendstatuses');

  for (const name of LEGACY_INDEX_NAMES) {
    // Look before dropping — a fresh environment has no `weekendstatuses`
    // collection yet, and `dropIndex` on a namespace that doesn't exist
    // throws NamespaceNotFound (code 26), not IndexNotFound (27); listing
    // first lets that case fall through as "nothing to drop" instead of a
    // second error code to special-case, and syncIndexes below creates the
    // collection (and its indexes) from scratch either way.
    let existing: any[] = [];
    try {
      existing = await col.indexes();
    } catch {
      existing = [];
    }
    if (!existing.find((i) => i?.name === name)) {
      console.log(`[migrate-weekend-indexes] "${name}" absent — nothing to drop`);
      continue;
    }
    try {
      await col.dropIndex(name);
      console.log(`[migrate-weekend-indexes] dropped legacy index "${name}"`);
    } catch (err: any) {
      if (err?.code === INDEX_NOT_FOUND_CODE || err?.codeName === 'IndexNotFound') {
        console.log(`[migrate-weekend-indexes] legacy index "${name}" already absent — skipping drop`);
      } else {
        throw err;
      }
    }
  }

  await WeekendStatus.syncIndexes();
  console.log('[migrate-weekend-indexes] weekend status indexes in sync');
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri, { autoIndex: false });
    console.log('[migrate-weekend-indexes] connected (autoIndex disabled)');
    await migrateWeekendIndexes();
    const after = await mongoose.connection.collection('weekendstatuses').indexes();
    console.log('[migrate-weekend-indexes] resulting indexes on weekendstatuses:');
    for (const idx of after as any[]) {
      console.log(`  - ${idx.name}: key=${JSON.stringify(idx.key)}${idx.unique ? ' unique' : ''}${idx.partialFilterExpression ? ` partial=${JSON.stringify(idx.partialFilterExpression)}` : ''}`);
    }
    await mongoose.disconnect();
    console.log('[migrate-weekend-indexes] done');
  })().catch((err) => {
    console.error('[migrate-weekend-indexes] failed:', err);
    process.exit(1);
  });
}
