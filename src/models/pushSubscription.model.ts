import { Schema, model, Document, Types } from 'mongoose';

/** One browser push endpoint for a buyer (a buyer may have several — one per
 *  browser/device). Dead endpoints (404/410 on send) are deleted by PushService. */
export interface IPushSubscription extends Document {
  buyerId: Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const pushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 1000 },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

export const PushSubscription = model<IPushSubscription>('PushSubscription', pushSubscriptionSchema);
