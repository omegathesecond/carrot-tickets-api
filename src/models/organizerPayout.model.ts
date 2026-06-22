import mongoose, { Schema, Document } from 'mongoose';

export type OrganizerPayoutStatus = 'open' | 'pending_payment' | 'settled';

export interface IOrganizerPayout extends Document {
  vendorId: mongoose.Types.ObjectId;
  periodStart: Date;
  periodEnd: Date;
  status: OrganizerPayoutStatus;
  // Ledger B aggregates — frozen at close time
  proceedsOwed: number;
  feeOwedByVendor: number;
  availableProceeds: number;
  netAmount: number;
  // Audit fields set at mark-paid time
  settledAt?: Date;
  settledBy?: string;
  paymentReference?: string;
  notes?: string;
}

const organizerPayoutSchema = new Schema<IOrganizerPayout>(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: {
      type: String,
      enum: ['open', 'pending_payment', 'settled'],
      default: 'open',
      index: true,
    },
    // Frozen aggregates
    proceedsOwed: { type: Number, required: true },
    feeOwedByVendor: { type: Number, required: true },
    availableProceeds: { type: Number, required: true },
    netAmount: { type: Number, required: true },
    // Audit
    settledAt: { type: Date },
    settledBy: { type: String },
    paymentReference: { type: String },
    notes: { type: String },
  },
  { timestamps: true },
);

export const OrganizerPayout = mongoose.model<IOrganizerPayout>(
  'OrganizerPayout',
  organizerPayoutSchema,
);
