/**
 * One-time, idempotent index migration for the `buyers` collection.
 *
 * BACKGROUND: `phone` and `email` were originally declared inline as
 * `{ unique: true, sparse: true }`. Two problems with that:
 *   1. Mongoose never rewrites an EXISTING index's options, so the legacy
 *      phone_1 created in the phone-primary era stayed NON-sparse in prod.
 *   2. A sparse unique index still treats an explicit `null` as a value, so it
 *      only tolerates absent fields, not null ones.
 * Net effect: every email-only buyer (no phone) after the first collided with
 * `E11000 duplicate key ... phone_1 dup key: { phone: null }` and could never
 * register.
 *
 * FIX: drop the stale phone_1 / email_1 and recreate them as PARTIAL unique
 * indexes that index ONLY documents whose value is an actual string. null and
 * absent are ignored entirely, so unlimited phone-only and email-only buyers
 * coexist while real handles stay unique. This matches buyer.model.ts exactly.
 *
 * Safe to re-run: it detects an already-partial index and skips it, and never
 * touches document data. Run against BOTH dev and prod DBs.
 *
 *   MONGODB_URI='...' npx ts-node -r tsconfig-paths/register src/scripts/fixBuyerContactIndexes.ts
 */
import mongoose from 'mongoose';

type Target = { field: 'phone' | 'email'; name: string };
const TARGETS: Target[] = [
  { field: 'phone', name: 'phone_1' },
  { field: 'email', name: 'email_1' },
];

const partialFilter = (field: string) => ({ [field]: { $type: 'string' } });

function isAlreadyPartial(idx: any, field: string): boolean {
  return (
    !!idx.unique &&
    !!idx.partialFilterExpression &&
    JSON.stringify(idx.partialFilterExpression) === JSON.stringify(partialFilter(field))
  );
}

export async function fixBuyerContactIndexes(): Promise<void> {
  const col = mongoose.connection.collection('buyers');
  const before = await col.indexes();
  console.log('[fixBuyerContactIndexes] before:', before.map((i) => i.name).join(', '));

  for (const { field, name } of TARGETS) {
    const existing = before.find(
      (i) => i.name === name || JSON.stringify(i.key) === JSON.stringify({ [field]: 1 }),
    );
    if (existing && isAlreadyPartial(existing, field)) {
      console.log(`[fixBuyerContactIndexes] ${field}: already partial-unique — skipping`);
      continue;
    }
    if (existing) {
      console.log(`[fixBuyerContactIndexes] ${field}: dropping stale ${existing.name}`);
      await col.dropIndex(existing.name!);
    }
    await col.createIndex(
      { [field]: 1 },
      { unique: true, partialFilterExpression: partialFilter(field), name },
    );
    console.log(`[fixBuyerContactIndexes] ${field}: created partial-unique ${name}`);
  }

  const after = await col.indexes();
  console.log('[fixBuyerContactIndexes] after:', after.map((i) => i.name).join(', '));
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    await fixBuyerContactIndexes();
    await mongoose.disconnect();
    console.log('[fixBuyerContactIndexes] done');
  })().catch((err) => {
    console.error('[fixBuyerContactIndexes] failed:', err);
    process.exit(1);
  });
}
