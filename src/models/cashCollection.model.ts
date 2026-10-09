import mongoose, { Schema, Types, Document } from 'mongoose';
export type CashCollectionStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled';
export interface ICashCollection extends Document {
  eventId: Types.ObjectId; cashierId: Types.ObjectId; collectorId: Types.ObjectId;
  cashierName: string; collectorName: string; amount: number; clientTxnId: string;
  status: CashCollectionStatus; createdAt: Date; resolvedAt?: Date; resolvedBy?: Types.ObjectId;
  ledgerTxnId?: string;
}
const schema = new Schema<ICashCollection>({
  eventId: { type: Schema.Types.ObjectId, required: true },
  cashierId: { type: Schema.Types.ObjectId, required: true },
  collectorId: { type: Schema.Types.ObjectId, required: true },
  cashierName: { type: String, required: true }, collectorName: { type: String, required: true },
  amount: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  clientTxnId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'rejected', 'cancelled'], required: true },
  resolvedAt: Date, resolvedBy: Schema.Types.ObjectId, ledgerTxnId: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ collectorId: 1, clientTxnId: 1 }, { unique: true });
schema.index({ eventId: 1, cashierId: 1, status: 1 });
schema.index({ eventId: 1, collectorId: 1, status: 1 });
schema.index({ eventId: 1, createdAt: -1 });
export const CashCollection = mongoose.model<ICashCollection>('CashCollection', schema);
