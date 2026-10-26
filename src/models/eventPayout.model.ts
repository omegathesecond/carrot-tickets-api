import { Schema, model } from 'mongoose';

export const PAYOUT_STATUSES = [
  'pending',
  'approved',
  'declined',
  'paid',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
const schema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    eventName: { type: String, required: true },
    eventDate: { type: Date, required: true },
    organizerName: { type: String, required: true },
    currency: { type: String, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    breakdown: { type: Schema.Types.Mixed, required: true },
    bankEncrypted: { type: String, required: true, select: false },
    bank: { type: Schema.Types.Mixed, required: true }, // Masked public snapshot only.
    status: {
      type: String,
      enum: PAYOUT_STATUSES,
      default: 'pending',
      required: true,
    },
    active: { type: Boolean, required: true, default: true },
    history: [
      {
        status: { type: String, enum: PAYOUT_STATUSES, required: true },
        at: { type: Date, required: true },
        by: { type: String, required: true },
        note: String,
      },
    ],
    paidAt: Date,
    paymentReference: String,
  },
  { timestamps: true },
);
// The database arbitrates simultaneous clicks, including across API instances.
schema.index(
  { eventId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
schema.index({ vendorId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
export const EventPayout = model('EventPayout', schema);

const bankSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, required: true, unique: true },
    encrypted: { type: String, required: true, select: false },
    version: { type: String, required: true },
    masked: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
export const PayoutBank = model('PayoutBank', bankSchema);
