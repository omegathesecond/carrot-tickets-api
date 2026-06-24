import mongoose, { Schema, Document } from 'mongoose';

export type WithdrawalStatus = 'requested' | 'approved' | 'paid' | 'rejected';

export interface IResellerCommissionWithdrawal extends Document {
  resellerId: mongoose.Types.ObjectId;
  amount: number;
  status: WithdrawalStatus;
  requestedBy: string;   // operatorId
  requestedAt: Date;
  snapshotAt: Date;      // cutoff the available balance was computed against
  approvedBy?: string;
  paidAt?: Date;
  paymentReference?: string;
  notes?: string;
}

const schema = new Schema<IResellerCommissionWithdrawal>(
  {
    resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['requested', 'approved', 'paid', 'rejected'],
      default: 'requested',
      index: true,
    },
    requestedBy: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    snapshotAt: { type: Date, required: true },
    approvedBy: { type: String },
    paidAt: { type: Date },
    paymentReference: { type: String },
    notes: { type: String },
  },
  { timestamps: true },
);

// Fast lookup for the "one open request at a time" guard.
schema.index({ resellerId: 1, status: 1 });

export const ResellerCommissionWithdrawal = mongoose.model<IResellerCommissionWithdrawal>(
  'ResellerCommissionWithdrawal',
  schema,
);
