import { Schema, model, Document, Types } from 'mongoose';

/**
 * One row per live gateway socket. The notification dispatcher treats a
 * buyer as ONLINE (suppressing push) when any row is fresher than the
 * staleness window; the gateway heartbeats its instance's rows and removes
 * them on disconnect/shutdown, so crashes only leave rows until they go stale.
 */
export interface IBuyerPresence extends Document {
  buyerId: Types.ObjectId;
  socketId: string;
  instanceId: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const buyerPresenceSchema = new Schema<IBuyerPresence>(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    socketId: { type: String, required: true, unique: true },
    instanceId: { type: String, required: true, index: true },
    lastSeenAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

export const BuyerPresence = model<IBuyerPresence>('BuyerPresence', buyerPresenceSchema);
