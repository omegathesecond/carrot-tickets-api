import { Buyer, NotificationPrefs } from '@models/buyer.model';
import { NotificationType } from '@models/notification.model';
import { NotificationService } from '@services/notification.service';
import { PushService } from '@services/push.service';
import { isBuyerOnline } from '@utils/buyerOnline.util';

export const PREF_BY_TYPE: Record<NotificationType, keyof NotificationPrefs> = {
  announcement: 'announcements',
  dm: 'dms',
  mention: 'mentions',
  friend: 'social',
  event_reminder: 'reminders',
};

const CHUNK = 50;

export class NotificationDispatcher {
  /**
   * The single notification funnel (spec §6): per-category prefs decide
   * whether anything happens at all; the inbox row is the durable record;
   * push goes only to OFFLINE buyers (gateway presence).
   */
  static async dispatch(
    recipientIds: string[],
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const prefKey = PREF_BY_TYPE[type];
    const unique = [...new Set(recipientIds.map(String))];

    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const buyers = await Buyer.find({ _id: { $in: chunk } }).select('notificationPrefs');
      await Promise.all(
        buyers.map(async (buyer) => {
          if (buyer.notificationPrefs?.[prefKey] === false) return; // toggled off — no inbox, no push
          const id = String(buyer._id);
          await NotificationService.create(id, type, title, body, data);
          if (!(await isBuyerOnline(id))) {
            await PushService.sendToBuyer(id, { title, body, data: { ...data, type } });
          }
        })
      );
    }
  }

  /** Fire-and-forget for request paths: notifications must never fail or
   *  slow the triggering write. Failures are loud in logs. */
  static dispatchAsync(
    recipientIds: string[],
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>
  ): void {
    NotificationDispatcher.dispatch(recipientIds, type, title, body, data).catch((err) =>
      console.error('[notify] dispatch failed:', err)
    );
  }
}
