import mongoose from 'mongoose';
import { Wallet } from '@models/wallet.model';
import { EventTag } from '@models/eventTag.model';

/**
 * One-time, idempotent: enrol every tag ALREADY in use at an event into that
 * event's register.
 *
 * The register (EventTag) is the allowlist WalletService.bindBand now checks,
 * so without this an event that was already running cashless before the
 * register existed would refuse to bind or reissue another tag mid-show — the
 * tags in the box would all read as strangers. A uid that is currently bound to
 * a wallet at an event is, by definition, one the organizer put into
 * circulation there, so back-filling it is a statement of fact rather than a
 * guess.
 *
 * `registeredBy` is deliberately left unset: nobody registered these, so the
 * register must not claim a person did.
 */
export async function backfillEventTagRegister(): Promise<{ scanned: number; inserted: number }> {
  const pairs = await Wallet.aggregate<{ _id: { eventId: mongoose.Types.ObjectId; bandUid: string } }>([
    { $match: { bandUid: { $ne: null } } },
    { $group: { _id: { eventId: '$eventId', bandUid: '$bandUid' } } },
  ]);

  if (!pairs.length) return { scanned: 0, inserted: 0 };

  const res = await EventTag.bulkWrite(
    pairs.map(({ _id }) => ({
      updateOne: {
        filter: { eventId: _id.eventId, bandUid: _id.bandUid },
        // $setOnInsert only: a tag the organizer has since RETIRED must stay
        // retired — re-activating it here would silently undo a deliberate
        // decision to pull it out of circulation.
        update: { $setOnInsert: { status: 'active', registeredAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return { scanned: pairs.length, inserted: res.upsertedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillEventTagRegister] done:', await backfillEventTagRegister());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillEventTagRegister] failed:', err);
    process.exit(1);
  });
}
