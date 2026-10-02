/**
 * Venue trading Phase 2 — drop the legacy product barcode index.
 *
 * `eventId_1_barcode_1` treated a venue product's missing eventId as null, so
 * one barcode at two venues collided. Product now declares
 * `event_barcode_unique` + `venue_barcode_unique` (built by autoIndex on boot,
 * or by this script); this drops the legacy one.
 *
 * Safe to re-run. Order-independent with the deploy: the new indexes have new
 * names and key orders, so they coexist with the legacy one until it is dropped.
 *
 * Run: MONGODB_URI=… npx ts-node -r tsconfig-paths/register src/scripts/migrate-product-barcode-index.ts
 */
import mongoose from 'mongoose';
import { getDatabaseURI } from '../config/database.config';
import { Product } from '../models/product.model';

const LEGACY = 'eventId_1_barcode_1';

/** Runs against the CURRENT mongoose connection, so a test can drive it. */
export async function migrateProductBarcodeIndex(): Promise<{ legacyDropped: boolean }> {
  await Product.createIndexes();
  const indexes = await Product.collection.indexes();
  if (!indexes.some((i) => i.name === LEGACY)) {
    console.log(`ℹ️  ${LEGACY} already gone`);
    return { legacyDropped: false };
  }
  await Product.collection.dropIndex(LEGACY);
  console.log(`🧹 dropped ${LEGACY}`);
  return { legacyDropped: true };
}

async function main(): Promise<void> {
  // autoIndex:false — the explicit createIndexes above is the only build.
  await mongoose.connect(getDatabaseURI(), { autoIndex: false });
  await migrateProductBarcodeIndex();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ migration failed', err); process.exit(1); });
}
