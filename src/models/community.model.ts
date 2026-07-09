import { Schema, model, Document, Types } from 'mongoose';

/**
 * One community per event, auto-created when the event is published. The
 * event page's Community tab is backed by this document and its channels.
 */
export interface ICommunity extends Document {
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const communitySchema = new Schema<ICommunity>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, unique: true, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  },
  { timestamps: true }
);

export const Community = model<ICommunity>('Community', communitySchema);
