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
  clientTxnId: { type: String, required: true, unique: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const WalletTopup = model<IWalletTopup>('WalletTopup', walletTopupSchema);
