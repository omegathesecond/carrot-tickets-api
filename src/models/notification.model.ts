import { Schema, model, Document, Types } from 'mongoose';

export type NotificationType = 'announcement' | 'dm' | 'mention' | 'friend' | 'event_reminder' | 'follow';

export type NotificationRecipientType = 'buyer' | 'vendor';

/** One in-app inbox entry. Every push the platform sends is mirrored here
 *  first (spec §6) — the inbox row is the durable record, push is delivery. */
export interface INotification extends Document {
  recipientType: NotificationRecipientType;
  recipientId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipientType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    recipientId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    type: {
      type: String,
      enum: ['announcement', 'dm', 'mention', 'friend', 'event_reminder', 'follow'],
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 300 },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ recipientType: 1, recipientId: 1, _id: -1 });
notificationSchema.index({ recipientType: 1, recipientId: 1, readAt: 1 });

// Reminder dedupe: one (event, kind) reminder per recipient, enforced at the
// DB so concurrent sweeps (multi-instance API) can never double-dispatch.
// Partial: only event_reminder rows pay for the index.
notificationSchema.index(
  { recipientId: 1, type: 1, 'data.eventId': 1, 'data.kind': 1 },
  { unique: true, partialFilterExpression: { type: 'event_reminder' } }
);

export const Notification = model<INotification>('Notification', notificationSchema);
