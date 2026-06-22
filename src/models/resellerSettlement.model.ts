import mongoose, { Schema, Document } from 'mongoose';

export type ResellerSettlementStatus = 'open' | 'pending_payment' | 'settled';

export interface IResellerSettlement extends Document {
  resellerId: mongoose.Types.ObjectId;
  periodStart: Date;
  periodEnd: Date;
  status: ResellerSettlementStatus;
  // Ledger A aggregates — frozen at close time
  cashOwedToCarrot: number;
  commissionOwedByCarrot: number;
  netAmount: number;
  byMethod: Record<string, number>;
  // Audit fields set at mark-paid time
  settledAt?: Date;
  settledBy?: string;
  paymentReference?: string;
  notes?: string;
}

const resellerSettlementSchema = new Schema<IResellerSettlement>(
  {
    resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: {
      type: String,
      enum: ['open', 'pending_payment', 'settled'],
      default: 'open',
      index: true,
    },
    // Frozen aggregates
    cashOwedToCarrot: { type: Number, required: true },
    commissionOwedByCarrot: { type: Number, required: true },
    netAmount: { type: Number, required: true },
    byMethod: { type: Schema.Types.Mixed, default: {} },
    // Audit
    settledAt: { type: Date },
    settledBy: { type: String },
    paymentReference: { type: String },
    notes: { type: String },
  },
  { timestamps: true },
);

resellerSettlementSchema.index(
  { resellerId: 1, periodStart: 1, periodEnd: 1 },
  { unique: true },
);

export const ResellerSettlement = mongoose.model<IResellerSettlement>(
  'ResellerSettlement',
  resellerSettlementSchema,
);
