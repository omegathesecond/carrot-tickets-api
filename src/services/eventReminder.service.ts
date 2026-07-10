import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Buyer } from '@models/buyer.model';
import { Notification } from '@models/notification.model';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';

type ReminderKind = 't24' | 'dayof';

export class EventReminderService {
  /**
   * Spec §6 event reminders for ticket holders: 't24' fires once when an
   * event is 12-24h out, 'dayof' once within the final 12h. Runs on an
   * interval (app.ts); dedupe is durable via the notifications themselves.
   */
  static async sweep(): Promise<void> {
    const now = Date.now();
    const events = await Event.find({
      status: EventStatus.PUBLISHED,
      startTime: { $gt: new Date(now), $lte: new Date(now + 24 * 60 * 60 * 1000) },
    }).select('name startTime');

    for (const event of events) {
      const until = new Date((event as any).startTime).getTime() - now;
      const kind: ReminderKind = until > 12 * 60 * 60 * 1000 ? 't24' : 'dayof';
      const eventId = String(event._id);

      const phones = await Ticket.distinct('customerPhone', {
        eventId: event._id,
        status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] },
      });
      if (phones.length === 0) continue;
      const holders = await Buyer.find({ phone: { $in: phones.filter(Boolean) } }).select('_id');
      if (holders.length === 0) continue;

      const already = await Notification.find({
        type: 'event_reminder',
        'data.eventId': eventId,
        'data.kind': kind,
      }).select('recipientId');
      const alreadyIds = new Set(already.map((n) => String(n.recipientId)));
      const recipients = holders.map((h) => String(h._id)).filter((id) => !alreadyIds.has(id));
      if (recipients.length === 0) continue;

      await NotificationDispatcher.dispatch(
        recipients,
        'event_reminder',
        event.name,
        kind === 't24' ? 'Starts in 24 hours 🎫' : 'Starts today 🎉',
        { eventId, kind }
      );
    }
  }
}
