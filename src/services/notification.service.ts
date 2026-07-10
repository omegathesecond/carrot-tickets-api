import { Notification, INotification, NotificationType } from '@models/notification.model';
import { IBuyer } from '@models/buyer.model';

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
}

export class NotificationService {
  static async create(
    recipientId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>
  ): Promise<INotification | null> {
    try {
      return await Notification.create({ recipientId, type, title, body, data });
    } catch (err: any) {
      // Concurrent reminder sweeps race the dedupe read; the partial unique
      // index makes the second insert a no-op instead of a duplicate row.
      if (err?.code === 11000 && type === 'event_reminder') return null;
      throw err;
    }
  }

  static async list(
    buyer: IBuyer,
    opts: { before?: string; limit?: number } = {}
  ): Promise<{ items: NotificationView[]; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { recipientId: buyer._id };
    if (opts.before) query['_id'] = { $lt: opts.before };

    const [docs, unreadCount] = await Promise.all([
      Notification.find(query).sort({ _id: -1 }).limit(limit),
      Notification.countDocuments({ recipientId: buyer._id, readAt: { $exists: false } }, { limit: 99 }),
    ]);

    return {
      items: docs.map((d) => ({
        id: String(d._id),
        type: d.type,
        title: d.title,
        body: d.body,
        data: d.data ?? {},
        read: Boolean(d.readAt),
        createdAt: d.createdAt,
      })),
      unreadCount,
    };
  }

  /** ids omitted → mark ALL of the buyer's notifications read; an EMPTY ids
   *  array is a no-op (an empty selection must never wipe the inbox).
   *  Scoped to the buyer so foreign ids are silently no-ops. */
  static async markRead(buyer: IBuyer, ids?: string[]): Promise<void> {
    const query: Record<string, unknown> = { recipientId: buyer._id, readAt: { $exists: false } };
    if (ids !== undefined) {
      if (ids.length === 0) return;
      query['_id'] = { $in: ids };
    }
    await Notification.updateMany(query, { $set: { readAt: new Date() } });
  }
}
