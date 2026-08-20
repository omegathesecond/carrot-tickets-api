import mongoose from 'mongoose';
import { EventTag } from '@models/eventTag.model';
import { normalizeBandUid } from '@utils/bandUid.util';

/**
 * Put tags into an event's register so a test can bind them.
 *
 * WalletService.bindBand refuses any tag the organizer has not enrolled (see
 * EventTag), which is the point of the register — but it makes "there is a tag
 * in my hand" a precondition of almost every cashless test. This writes the
 * rows directly rather than going through EventTagService.registerTag so that
 * suites which use obviously-fake uid fixtures ('SAMEUID1', 'DUPUID01') keep
 * working: they are testing binding semantics, not uid formatting, and the
 * strict hex check belongs on the real entry points, not here.
 */
export async function enrolTags(eventId: string | mongoose.Types.ObjectId, ...bandUids: string[]): Promise<void> {
  if (!bandUids.length) return;
  const eid = typeof eventId === 'string' ? new mongoose.Types.ObjectId(eventId) : eventId;
  await EventTag.bulkWrite(
    [...new Set(bandUids.map(normalizeBandUid))].map((bandUid) => ({
      updateOne: {
        filter: { eventId: eid, bandUid },
        update: { $setOnInsert: { status: 'active', registeredAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}
