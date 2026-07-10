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
  ): Promise<INotification> {
    return Notification.create({ recipientId, type, title, body, data });
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

  /** ids omitted → mark ALL of the buyer's notifications read. Scoped to the
   *  buyer so foreign ids are silently no-ops (never someone else's inbox). */
  static async markRead(buyer: IBuyer, ids?: string[]): Promise<void> {
    const query: Record<string, unknown> = { recipientId: buyer._id, readAt: { $exists: false } };
    if (ids && ids.length > 0) query['_id'] = { $in: ids };
    await Notification.updateMany(query, { $set: { readAt: new Date() } });
  }
}
