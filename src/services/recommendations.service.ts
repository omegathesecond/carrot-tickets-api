import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { SavedContentService } from '@services/savedContent.service';
import { notEndedFilter } from '@utils/eventVisibility.util';
import { seededShuffle } from '@utils/seededShuffle.util';

const TARGET = 8;

export class RecommendationsService {
  /** v1: basis = most-recently-saved event; recommend that organizer's other
   *  upcoming events first, then top up with soonest-upcoming, excluding saved.
   *  (Phase 2 adds same-category matching.) */
  static async forBuyer(
    buyerId: string,
    { seed }: { seed?: number } = {}
  ): Promise<{ basisEvent: { id: string; name: string } | null; eventIds: string[] }> {
    const savedIds = await SavedContentService.savedEventIds(buyerId);
    const exclude = new Set(savedIds);
    const base = { status: EventStatus.PUBLISHED, ...notEndedFilter() };

    let basisEvent: { id: string; name: string } | null = null;
    const picked: string[] = [];

    if (savedIds.length) {
      const basis = await Event.findById(savedIds[0]).select('name vendorId');
      if (basis) {
        basisEvent = { id: String(basis._id), name: basis.name };
        const sameOrg = await Event.find({ ...base, vendorId: basis.vendorId, _id: { $nin: [...exclude] } }).sort({ eventDate: 1 }).limit(TARGET).select('_id');
        for (const e of sameOrg) { picked.push(String(e._id)); exclude.add(String(e._id)); }
      }
    }
    if (picked.length < TARGET) {
      const need = TARGET - picked.length;
      const query = { ...base, _id: { $nin: [...exclude] } };
      if (seed === undefined) {
        // Deterministic — soonest upcoming, unchanged.
        const more = await Event.find(query).sort({ eventDate: 1 }).limit(need).select('_id');
        for (const e of more) picked.push(String(e._id));
      } else {
        // Seeded — shuffle a bounded soonest-upcoming pool so the generic fill
        // varies per visit while the personalized picks above stay put.
        const FILL_POOL = 32;
        const pool = await Event.find(query).sort({ eventDate: 1 }).limit(FILL_POOL).select('_id');
        const shuffled = seededShuffle(pool.map((e) => String(e._id)), seed);
        for (const id of shuffled.slice(0, need)) picked.push(id);
      }
    }
    return { basisEvent, eventIds: picked };
  }
}
