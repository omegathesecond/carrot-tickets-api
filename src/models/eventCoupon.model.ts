import mongoose, { Schema } from 'mongoose';
import { IEventCoupon } from '@interfaces/eventCoupon.interface';

const schema = new Schema<IEventCoupon>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
  code: { type: String, required: true },
  label: { type: String, default: '', maxlength: 100 },
  discountType: { type: String, enum: ['percentage', 'fixed'], required: true },
  discountValue: { type: Number, required: true, min: 0.01 },
  ticketTypeIds: { type: [String], default: [] },
  expiresAt: Date,
  disabled: { type: Boolean, default: false },
  saleId: { type: Schema.Types.ObjectId, ref: 'TicketSale', default: null },
}, { timestamps: true });

schema.index({ eventId: 1, code: 1 }, { unique: true });
schema.index({ eventId: 1, createdAt: -1, _id: -1 });
export const EventCoupon = mongoose.model<IEventCoupon>('EventCoupon', schema);
