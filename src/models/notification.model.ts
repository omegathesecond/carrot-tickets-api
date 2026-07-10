import { Schema, model, Document, Types } from 'mongoose';

export type NotificationType = 'announcement' | 'dm' | 'mention' | 'friend' | 'event_reminder';

/** One in-app inbox entry. Every push the platform sends is mirrored here
 *  first (spec §6) — the inbox row is the durable record, push is delivery. */
export interface INotification extends Document {
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
    recipientId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    type: {
      type: String,
      enum: ['announcement', 'dm', 'mention', 'friend', 'event_reminder'],
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 300 },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ recipientId: 1, _id: -1 });
notificationSchema.index({ recipientId: 1, readAt: 1 });

export const Notification = model<INotification>('Notification', notificationSchema);
