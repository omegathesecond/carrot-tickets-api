/**
 * Venue trading Phase 3 — build the selling indexes; drop the legacy table label index.
 *
 * `eventId_1_label_1` (unique where status:'open') treated a venue table's
 * missing eventId as null, so two venues could not both have an open "7".
 * Table now declares `event_open_label_unique` + `venue_open_label_unique`.
 *
 * This script also BUILDS the Phase 3 indexes on Table, Waiter, MerchantCharge
 * and VenuePayment: autoIndex was seen to build none of Phase 2's new indexes
 * on an idle service, so it is not relied on.
 *
 * RUN ORDER — against each environment's DB:
 *   1. AFTER the new API revision holds 100% traffic. An old revision that
 *      cold-starts still declares the legacy index, and its autoIndex would
 *      re-create `eventId_1_label_1` behind this script.
 *   2. BEFORE venue waiters open tables.
 *   3. AGAIN after any rollback → roll-forward.
 *
 * Safe to re-run: dropping is existence-guarded and createIndexes is idempotent.
 *
 *   MONGODB_URI='...' npm run migrate:venue-selling-indexes
 */
import mongoose from 'mongoose';
import { Table } from '../models/table.model';
import { Waiter } from '../models/waiter.model';
import { MerchantCharge } from '../models/merchantCharge.model';
import { VenuePayment } from '../models/venuePayment.model';

const LEGACY = 'eventId_1_label_1';

/** Runs against the CURRENT mongoose connection, so a test can drive it. */
export async function migrateVenueSellingIndexes(): Promise<{ legacyDropped: boolean }> {
  for (const model of [Table, Waiter, MerchantCharge, VenuePayment] as mongoose.Model<any>[]) {
    await model.createIndexes();
    console.log(`✅ indexes built: ${model.modelName}`);
  }
  const indexes = await Table.collection.indexes();
  if (!indexes.some((i) => i.name === LEGACY)) {
    console.log(`ℹ️  ${LEGACY} already gone`);
    return { legacyDropped: false };
  }
  await Table.collection.dropIndex(LEGACY);
  console.log(`🧹 dropped ${LEGACY}`);
  return { legacyDropped: true };
}

/** The CLI entrypoint. Exported so a test can pin the missing-URI refusal. */
export async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is not set');
  // autoIndex:false — the explicit createIndexes above is the only build.
  await mongoose.connect(uri, { autoIndex: false });
  await migrateVenueSellingIndexes();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ migration failed', err); process.exit(1); });
}
