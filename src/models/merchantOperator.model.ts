// api/src/models/merchantOperator.model.ts
import mongoose, { Schema } from 'mongoose';
import { IMerchantOperator } from '@interfaces/merchantOperator.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * A person on the till at one stall (cashless spec — per-person operators).
 * Same PIN-login shape as Cashier/GateOperator via applyOperatorCredentials.
 * Attribution only: money is still owed to the STALL, so no ledger account
 * ever references this document.
 */
const merchantOperatorSchema = new Schema<IMerchantOperator>({
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true, immutable: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(merchantOperatorSchema);

merchantOperatorSchema.index({ merchantId: 1, isActive: 1 });

export const MerchantOperator = mongoose.model<IMerchantOperator>('MerchantOperator', merchantOperatorSchema);
