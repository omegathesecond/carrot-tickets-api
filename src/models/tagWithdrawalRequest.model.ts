import { Schema, model } from 'mongoose';

export const TAG_WITHDRAWAL_STATUSES = ['pending', 'processing', 'paid', 'rejected'] as const;
export type TagWithdrawalStatus = typeof TAG_WITHDRAWAL_STATUSES[number];

const schema = new Schema({
  walletId: { type: Schema.Types.ObjectId, required: true, ref: 'Wallet' },
  eventId: { type: Schema.Types.ObjectId, required: true, ref: 'Event' },
  eventName: { type: String, required: true },
  bandUid: { type: String, required: true },
  amount: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  currency: { type: String, required: true, enum: ['SZL', 'ZAR'] },
  country: { type: String, required: true, enum: ['SZ', 'ZA'] },
  method: { type: String, required: true, enum: ['mobile_money', 'bank_transfer'] },
  // Payout/contact details are encrypted with the existing authenticated key lifecycle.
  detailsEncrypted: { type: String, required: true, select: false },
  destinationSummary: { type: String, required: true },
  clientTxnId: { type: String, required: true },
  trackingHash: { type: String, required: true, select: false },
  inputHash: { type: String, required: true, select: false },
  status: { type: String, enum: TAG_WITHDRAWAL_STATUSES, default: 'pending', required: true },
  active: { type: Boolean, required: true, default: true },
  processingBy: String,
  paymentReference: String,
  paidAt: Date,
  rejectionReason: String,
  history: [{ status: { type: String, enum: TAG_WITHDRAWAL_STATUSES, required: true }, at: { type: Date, required: true }, by: { type: String, required: true }, note: String }],
}, { timestamps: true });
schema.index({ walletId: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ walletId: 1, clientTxnId: 1 }, { unique: true });
schema.index({ status: 1, createdAt: -1 });
schema.index({ eventId: 1, createdAt: -1 });
export const TagWithdrawalRequest = model('TagWithdrawalRequest', schema);
