/**
 * Venue trading Phase 2 — drop the legacy product barcode index.
 *
 * `eventId_1_barcode_1` treated a venue product's missing eventId as null, so
 * one barcode at two venues collided. Product now declares
 * `event_barcode_unique` + `venue_barcode_unique` (built by autoIndex on boot,
 * or by this script); this drops the legacy one.
 *
 * RUN ORDER — against each environment's DB:
 *   1. AFTER the new API revision holds 100% traffic. An old revision that
 *      cold-starts still declares the legacy index, and its autoIndex would
 *      re-create `eventId_1_barcode_1` behind this script.
 *   2. BEFORE venues add barcoded products — until it runs, the same barcode
 *      at two venues still collides.
 *   3. AGAIN after any rollback → roll-forward: the rolled-back revision's
 *      autoIndex re-creates the legacy index.
 *
 * Safe to re-run: dropping is existence-guarded and createIndexes is idempotent.
 *
 *   MONGODB_URI='...' npm run migrate:product-barcode-index
 */
import mongoose from 'mongoose';
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

/** The CLI entrypoint. Exported so a test can pin the missing-URI refusal. */
export async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is not set');
  // autoIndex:false — the explicit createIndexes above is the only build.
  await mongoose.connect(uri, { autoIndex: false });
  await migrateProductBarcodeIndex();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ migration failed', err); process.exit(1); });
}
