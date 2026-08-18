/**
 * One-time migration for the `merchants` collection — stalls stop holding
 * credentials (per-person cashless operators).
 *
 * BACKGROUND: `Merchant` used to carry `loginCode` (unique, NON-sparse) plus
 * the shared PIN/lockout fields. Credentials now live on `MerchantOperator`,
 * one document per PERSON on the till, so `Merchant` declares neither field.
 *
 * Two things break on an existing database if this is not run:
 *
 *  1. LOGIN. Every stall's staff logs in with the stall's loginCode today.
 *     Once the login dispatcher probes MerchantOperator instead of Merchant,
 *     those codes match nothing and the POS stops accepting them. So each
 *     credentialed stall gets ONE operator carrying its existing loginCode
 *     and its already-bcrypt-hashed PIN — inserted through the raw driver so
 *     the pre-save hook does not re-hash the hash. Staff keep the code and
 *     PIN they have; the organizer can then add real named people.
 *
 *  2. CREATING STALLS. `loginCode_1` is unique and NOT sparse, so MongoDB
 *     indexes a MISSING loginCode as null. The first credential-less stall
 *     inserts fine and every one after it dies on E11000 {loginCode: null}.
 *     Mongoose never drops indexes for fields you removed from the schema,
 *     so the index has to go explicitly.
 *
 * Safe to re-run: the operator backfill is existence-guarded, dropIndex
 * ignores IndexNotFound (server code 27), and the $unset is a no-op once the
 * fields are gone. Run against BOTH dev and prod DBs BEFORE the API revision
 * that drops the fields serves traffic.
 *
 *   MONGODB_URI='...' npm run migrate:merchant-credentials
 */
import mongoose from 'mongoose';
import { getDatabaseURI } from '../config/database.config';

export interface MigrationResult {
  /** Stalls found still carrying a loginCode. */
  legacyStalls: number;
  /** MerchantOperators inserted by this run (0 on a re-run). */
  operatorsCreated: number;
  /** True if this run dropped merchants.loginCode_1 (false if already gone). */
  indexDropped: boolean;
}

/**
 * Runs against the CURRENT mongoose connection, so a test can drive it against
 * the in-memory harness. The CLI entrypoint below opens its own connection.
 */
export async function migrateMerchantCredentials(): Promise<MigrationResult> {
  const db = mongoose.connection.db!;
  const merchants = db.collection('merchants');
  const operators = db.collection('merchantoperators');

  // ── 1. one operator per credentialed stall, keeping code + hashed PIN ─────
  const legacy = await merchants.find({ loginCode: { $exists: true, $ne: null } }).toArray();
  let created = 0;
  for (const m of legacy) {
    if (await operators.findOne({ loginCode: m['loginCode'] })) continue; // already migrated
    await operators.insertOne({
      fullName: `${m['name']} till`,
      merchantId: m._id,
      eventId: m['eventId'],
      loginCode: m['loginCode'],
      pin: m['pin'],                       // already a bcrypt hash — insert raw, do NOT re-hash
      isActive: (m['status'] ?? 'active') === 'active',
      failedPinAttempts: m['failedPinAttempts'] ?? 0,
      lockedUntil: m['lockedUntil'] ?? null,
      ...(m['lastLoginAt'] ? { lastLoginAt: m['lastLoginAt'] } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    created++;
  }
  console.log(`👤 carried ${created} stall login(s) over to MerchantOperator (${legacy.length} credentialed stall(s) found)`);

  // ── 2. drop the unique non-sparse index the removed field left behind ─────
  let indexDropped = false;
  try {
    await merchants.dropIndex('loginCode_1');
    indexDropped = true;
    console.log('🗑️  dropped merchants.loginCode_1');
  } catch (e: any) {
    if (e?.code === 27) console.log('… merchants.loginCode_1 already gone');
    else throw e;
  }

  // ── 3. clear the dead fields off the stalls ───────────────────────────────
  const res = await merchants.updateMany(
    {},
    { $unset: { loginCode: '', pin: '', failedPinAttempts: '', lockedUntil: '', lastLoginAt: '' } },
  );
  console.log(`🧹 cleared credential fields from ${res.modifiedCount} stall(s)`);

  return { legacyStalls: legacy.length, operatorsCreated: created, indexDropped };
}

async function main(): Promise<void> {
  // autoIndex:false for the same reason as migrate-review-indexes: a
  // background createIndexes must not race the explicit drop below.
  await mongoose.connect(getDatabaseURI(), { autoIndex: false });
  await migrateMerchantCredentials();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ migration failed', err); process.exit(1); });
}
