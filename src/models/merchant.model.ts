// api/src/models/merchant.model.ts
import mongoose, { Schema } from 'mongoose';
import { IMerchant } from '@interfaces/merchant.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * A tap-to-pay vendor at one cashless event (cashless spec) — logs in with a
 * loginCode+PIN (mirrors GateOperator/ResellerOperator) and charges attendees'
 * NFC-band wallets via POST /api/merchant/charge. commissionPercent is the
 * platform's cut of every charge, read fresh from this document on every
 * charge (not cached in the JWT) so a rate change takes effect immediately.
 */
const merchantSchema = new Schema<IMerchant>({
  name: { type: String, required: true, trim: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(merchantSchema);

merchantSchema.index({ eventId: 1, status: 1 });

export const Merchant = mongoose.model<IMerchant>('Merchant', merchantSchema);
