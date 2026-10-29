import { Schema, model } from 'mongoose';

export const GUARANTEE_STATUSES = ['requested', 'accepted', 'provider_rejected', 'withdrawn', 'pending', 'paid', 'rejected'] as const;
const schema = new Schema({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  organizerId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
  providerId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
  eventName: { type: String, required: true },
  organizerName: { type: String, required: true },
  providerName: { type: String, required: true },
  currency: { type: String, required: true },
  amount: { type: Number, required: true, min: 0.01 },
  description: { type: String, required: true },
  expectedPaymentDate: { type: Date, required: true },
  status: { type: String, enum: GUARANTEE_STATUSES, default: 'requested', required: true },
  agreement: { type: Buffer, select: false },
  agreementName: String,
  history: [{ status: { type: String, enum: GUARANTEE_STATUSES, required: true }, at: { type: Date, required: true }, by: { type: String, required: true }, note: String }],
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ organizerId: 1, eventId: 1, createdAt: -1 });
schema.index({ providerId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
export const Guarantee = model('Guarantee', schema);
