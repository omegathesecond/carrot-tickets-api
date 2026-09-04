/**
 * One-time cleanup for the `cashiers` collection — organizer cashiers are now
 * hired for exactly ONE event.
 *
 * BACKGROUND: `Cashier` used to carry an `eventIds` array where an EMPTY set
 * meant "every event this organizer runs". It now carries a singular,
 * immutable `eventId`, REQUIRED for organizer scope. Platform cashiers are
 * Carrot's own staff and stay global — they are the only cashier that may
 * legitimately have no event.
 *
 * Two things are wrong with a pre-change organizer cashier if this is not run:
 *
 *  1. AUTHORIZATION. `required` fires on WRITE, not on read, so a legacy row
 *     reads back with no eventId at all. resolveOperatorEventScope now fails
 *     CLOSED on that row (returns an empty allow-list), which is the safe
 *     answer but a confusing one: she can log in and then be refused at every
 *     event, with no way to tell her apart from a misconfiguration.
 *
 *  2. SHE CANNOT BE REPAIRED THROUGH THE API. `eventId` is immutable, the
 *     admin update no longer accepts it, and there is no delete route — and
 *     both update and resetPin end in `cashier.save()`, which now throws
 *     ValidationError on a row with no event. So she can be neither fixed,
 *     deactivated, nor PIN-reset without direct database access.
 *
 * DELETES rather than backfills. Which event a legacy cashier was hired for is
 * genuinely unknowable — the old empty `eventIds` meant "all of them", so
 * there is no answer hiding in the data. Inventing one would be a fabrication
 * that silently grants her a real event, so the organizer re-hires her instead.
 *
 * Her financial history is NOT touched. Wallet transactions reference her by
 * id and are the ledger of money that actually moved; deleting those would be
 * destroying accounting records, not cleaning up. The rows stay, pointing at a
 * cashier who no longer exists, exactly as they would for any departed staff.
 *
 * Safe to re-run: the second run matches nothing.
 *
 *   MONGODB_URI='...' npm run cleanup:eventless-cashiers
 */
import mongoose from 'mongoose';
import { getDatabaseURI } from '../config/database.config';

export interface CleanupResult {
  /** Organizer cashiers found carrying no event (legacy rows). */
  legacyCashiers: number;
  /** Rows actually removed by this run (0 on a re-run). */
  deleted: number;
}

/**
 * Runs against the CURRENT mongoose connection, so a test can drive it against
 * the in-memory harness. The CLI entrypoint below opens its own connection.
 *
 * Deliberately goes through the raw driver: the Mongoose model would now
 * refuse to hydrate these documents on write, and this has to operate on rows
 * the current schema considers invalid.
 */
export async function cleanupEventlessCashiers(): Promise<CleanupResult> {
  const cashiers = mongoose.connection.db!.collection('cashiers');

  // scope:'organizer' AND no event. Matching on `scope` rather than on the
  // presence of vendorId is what keeps PLATFORM cashiers — legitimately
  // global, legitimately event-less — out of the blast radius.
  const filter = { scope: 'organizer', $or: [{ eventId: { $exists: false } }, { eventId: null }] };

  const doomed = await cashiers.find(filter).project({ fullName: 1, loginCode: 1, vendorId: 1 }).toArray();
  for (const c of doomed) {
    console.log(`🗑️  removing legacy cashier "${c['fullName']}" (login ${c['loginCode']}, organizer ${c['vendorId']}) — no event, must be re-hired`);
  }

  const res = await cashiers.deleteMany(filter);
  console.log(`🧹 removed ${res.deletedCount} event-less organizer cashier(s); their wallet transactions are untouched`);

  return { legacyCashiers: doomed.length, deleted: res.deletedCount };
}

async function main(): Promise<void> {
  await mongoose.connect(getDatabaseURI());
  await cleanupEventlessCashiers();
  await mongoose.disconnect();
}

// Importing this module (from its test) must not connect or exit.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('❌ cleanup failed', err); process.exit(1); });
}
