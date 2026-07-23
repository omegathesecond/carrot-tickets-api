import { Event } from '@models/event.model';
import { GoingService } from '@services/going.service';
import { SavedContentService } from '@services/savedContent.service';
import type { IBuyer } from '@models/buyer.model';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class CalendarService {
  /** Union of going + saved events in `year` (UTC), grouped by short month name. */
  static async forYear(buyer: IBuyer, year: number): Promise<{ monthCounts: Record<string, number>; eventIds: string[] }> {
    const [going, saved] = await Promise.all([
      GoingService.goingEventIds(buyer),
      SavedContentService.savedEventIds(String(buyer._id)),
    ]);
    const ids = [...new Set([...going, ...saved])];
    if (ids.length === 0) return { monthCounts: {}, eventIds: [] };

    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    const events = await Event.find({ _id: { $in: ids }, eventDate: { $gte: start, $lt: end } })
      .sort({ eventDate: 1 })
      .select('eventDate');

    const monthCounts: Record<string, number> = {};
    for (const e of events) {
      const m = MONTHS[new Date(e.eventDate).getUTCMonth()]!;
      monthCounts[m] = (monthCounts[m] ?? 0) + 1;
    }
    return { monthCounts, eventIds: events.map((e) => String(e._id)) };
  }
}
