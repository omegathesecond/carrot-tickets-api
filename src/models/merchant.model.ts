// api/src/models/merchant.model.ts
import mongoose, { Schema } from 'mongoose';
import { IMerchant } from '@interfaces/merchant.interface';

/**
 * A tap-to-pay STALL at one cashless event (cashless spec). It holds the
 * stall's identity and its settlement side — name, commissionPercent (the
 * platform's cut, read fresh from this document on every charge rather than
 * cached in the JWT, so a rate change takes effect immediately) and the
 * MERCHANT ledger account money is owed to.
 *
 * It holds NO credentials. The people on the till are MerchantOperator
 * documents, each with their own loginCode + PIN, so a charge names a human
 * and one person can be revoked without rotating the whole stall.
 */
const merchantSchema = new Schema<IMerchant>({
  name: { type: String, required: true, trim: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { __v, ...rest } = ret; return rest; } },
});

merchantSchema.index({ eventId: 1, status: 1 });

export const Merchant = mongoose.model<IMerchant>('Merchant', merchantSchema);
