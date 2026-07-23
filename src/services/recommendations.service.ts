import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { SavedContentService } from '@services/savedContent.service';

const TARGET = 8;

export class RecommendationsService {
  /** v1: basis = most-recently-saved event; recommend that organizer's other
   *  upcoming events first, then top up with soonest-upcoming, excluding saved.
   *  (Phase 2 adds same-category matching.) */
  static async forBuyer(buyerId: string): Promise<{ basisEvent: { id: string; name: string } | null; eventIds: string[] }> {
    const savedIds = await SavedContentService.savedEventIds(buyerId);
    const exclude = new Set(savedIds);
    const now = new Date();
    const base = { status: EventStatus.PUBLISHED, eventDate: { $gte: now } };

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
      const more = await Event.find({ ...base, _id: { $nin: [...exclude] } }).sort({ eventDate: 1 }).limit(TARGET - picked.length).select('_id');
      for (const e of more) picked.push(String(e._id));
    }
    return { basisEvent, eventIds: picked };
  }
}
