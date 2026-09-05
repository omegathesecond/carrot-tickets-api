/**
 * Index migration for the `wallets` collection (standalone tag wallets,
 * design 2026-09-05).
 *
 * BACKGROUND: `Wallet.ticketId` used to be required and carried a plain
 * `{ ticketId: 1 }` unique index — one wallet per ticket, the wallet identity.
 * A tag handed out at the Register desk on its own now gets a wallet with NO
 * ticket, identified by its band instead. Two such wallets both carry
 * `ticketId: null` and collide on that plain unique index.
 *
 * FIX (wallet.model.ts): `ticketId` is optional, and its index is PARTIAL —
 * `partialFilterExpression: { ticketId: { $exists: true } }` — so it indexes
 * only wallets that actually belong to a ticket. Mongoose never rewrites an
 * existing index's options in place, so the legacy non-partial `ticketId_1`
 * has to be dropped explicitly before `Wallet.syncIndexes()` can recreate it
 * under the same name; otherwise syncIndexes sees a name collision with
 * different options and throws IndexKeySpecsConflict.
 *
 * Safe to re-run: dropIndex ignores "index not found" (server code 27) and
 * syncIndexes() is idempotent. Runs at boot (see app.ts) so an environment
 * nobody migrated by hand self-heals on its next deploy.
 *
 * The Wallet schema turns its own autoIndex off outside tests so this is the
 * only thing that ever builds these indexes — a background autoIndex build
 * would otherwise race the drop and lose.
 */
import mongoose from 'mongoose';
import { Wallet } from '@models/wallet.model';

// Was a plain unique index; is now partial (ticketId exists).
const LEGACY_INDEX_NAMES = ['ticketId_1'];
const INDEX_NOT_FOUND_CODE = 27; // MongoDB server error code: IndexNotFound

export async function migrateWalletIndexes(): Promise<void> {
  const col = mongoose.connection.collection('wallets');

  for (const name of LEGACY_INDEX_NAMES) {
    // Only drop the LEGACY shape. Once migrated, ticketId_1 exists again as a
    // partial index and must be left alone — dropping and rebuilding it on
    // every boot would churn an index on a live money collection.
    let existing: any[] = [];
    try {
      existing = await col.indexes();
    } catch {
      // Collection does not exist yet (fresh environment) — nothing to drop,
      // and syncIndexes below will create everything from scratch.
      existing = [];
    }
    const found = existing.find((i) => i?.name === name);
    if (!found) {
      console.log(`[migrate-wallet-indexes] "${name}" absent — nothing to drop`);
      continue;
    }
    if (found.partialFilterExpression) {
      console.log(`[migrate-wallet-indexes] "${name}" already partial — leaving it`);
      continue;
    }
    try {
      await col.dropIndex(name);
      console.log(`[migrate-wallet-indexes] dropped legacy non-partial index "${name}"`);
    } catch (err: any) {
      if (err?.code === INDEX_NOT_FOUND_CODE || err?.codeName === 'IndexNotFound') {
        console.log(`[migrate-wallet-indexes] "${name}" already absent — skipping drop`);
      } else {
        throw err;
      }
    }
  }

  await Wallet.syncIndexes();
  console.log('[migrate-wallet-indexes] wallet indexes in sync');
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    // autoIndex disabled for the same reason as migrate-review-indexes: a
    // background build racing the drop is exactly the failure this migration
    // exists to avoid.
    await mongoose.connect(uri, { autoIndex: false });
    console.log('[migrate-wallet-indexes] connected (autoIndex disabled)');
    await migrateWalletIndexes();
    const after = await mongoose.connection.collection('wallets').indexes();
    console.log('[migrate-wallet-indexes] resulting indexes on wallets:');
    for (const idx of after as any[]) {
      console.log(`  - ${idx.name}: key=${JSON.stringify(idx.key)}${idx.unique ? ' unique' : ''}${idx.partialFilterExpression ? ` partial=${JSON.stringify(idx.partialFilterExpression)}` : ''}`);
    }
    await mongoose.disconnect();
    console.log('[migrate-wallet-indexes] done');
  })().catch((err) => {
    console.error('[migrate-wallet-indexes] failed:', err);
    process.exit(1);
  });
}
