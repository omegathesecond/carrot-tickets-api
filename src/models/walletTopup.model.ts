import { Schema, model, Document, Types } from 'mongoose';

export interface IWalletTopup extends Document {
  walletId: Types.ObjectId; eventId: Types.ObjectId; amount: number;
  method: 'cash'; status: 'completed'; recordedBy: string; clientTxnId: string; createdAt: Date;
}
const walletTopupSchema = new Schema<IWalletTopup>({
  walletId: { type: Schema.Types.ObjectId, required: true, index: true },
  eventId: { type: Schema.Types.ObjectId, required: true, index: true },
  amount: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'amount must be integer cents' } },
  method: { type: String, enum: ['cash'], required: true },
  status: { type: String, enum: ['completed'], required: true, default: 'completed' },
  recordedBy: { type: String, required: true },
  clientTxnId: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Idempotency is scoped to the OWNING wallet, NOT global. A globally-unique
// clientTxnId meant two different callers reusing the same id collided: the
// second's lookup/E11000-recovery returned the FIRST wallet's row, leaking data
// and silently skipping the second credit (a 200 with no money moved). Scoping
// the uniqueness to {walletId, clientTxnId} means the same id on a DIFFERENT
// wallet no longer collides, while a genuine retry for the SAME wallet still
// dedups.
walletTopupSchema.index({ walletId: 1, clientTxnId: 1 }, { unique: true });

export const WalletTopup = model<IWalletTopup>('WalletTopup', walletTopupSchema);
