import webpush from 'web-push';
import { PushSubscription } from '@models/pushSubscription.model';
import { vapidConfigured } from '@config/vapid.config';

export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export class PushService {
  /**
   * Best-effort Web Push to every subscription the buyer has. NEVER throws —
   * the inbox row is the durable record; this is delivery only. 404/410
   * (expired/unsubscribed endpoints) self-clean.
   */
  static async sendToBuyer(buyerId: string, payload: PushPayload): Promise<void> {
    if (!vapidConfigured) {
      console.error('[push] skipped — VAPID not configured');
      return;
    }
    const subs = await PushSubscription.find({ buyerId });
    if (subs.length === 0) return;

    const json = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
            json
          );
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await PushSubscription.deleteOne({ _id: sub._id }).catch((delErr) =>
              console.error('[push] dead-subscription cleanup failed:', delErr)
            );
            return;
          }
          console.error('[push] send failed (inbox row already durable):', err);
        }
      })
    );
  }
}
