// api/src/models/cashier.model.ts
import mongoose, { Schema } from 'mongoose';
import { ICashier } from '@interfaces/cashier.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * In-venue money-desk operator for an organizer (cashless spec — cashier
 * slice). Same PIN-login shape as GateOperator, reusing the shared
 * applyOperatorCredentials mechanism (pin hash, lockout, comparePin) — this
 * actor is NOT a reseller and never carries reseller naming.
 */
const cashierSchema = new Schema<ICashier>({
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  scope: { type: String, required: true, enum: ['platform', 'organizer'], index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(cashierSchema);

cashierSchema.index({ vendorId: 1, isActive: 1 });

export const Cashier = mongoose.model<ICashier>('Cashier', cashierSchema);
