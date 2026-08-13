import mongoose, { Schema, Document } from 'mongoose';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';

/**
 * One append-only leg of the stock journal (design §4/§5). Written ONLY by
 * StockService.applyMovement. `balanceAfter` is the onHand immediately after
 * this movement — captures "stock before/after" for the itemised receipt and
 * the transaction log without recomputation. Per bar-product,
 * onHand == Σ delta (the invariant, property-tested).
 */
export interface IStockMovement extends Document {
  eventId: mongoose.Types.ObjectId;
  merchantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  delta: number; // signed integer base units, non-zero
  reason: StockMovementReason;
  balanceAfter: number;
  refType?: string;
  refId?: string;
  byType: StockMovementByType;
  by: string;
  note?: string;
  at: Date;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    delta: {
      type: Number, required: true,
      validate: { validator: Number.isSafeInteger, message: 'delta must be a whole number of base units' },
    },
    reason: { type: String, enum: Object.values(StockMovementReason), required: true },
    balanceAfter: {
      type: Number, required: true, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'balanceAfter must be a whole number' },
    },
    refType: { type: String },
    refId: { type: String },
    byType: { type: String, enum: ['Organizer', 'Merchant', 'Platform'], required: true },
    by: { type: String, required: true },
    note: { type: String, trim: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

// Per bar-product journal, newest first (statement view + Σ delta invariant).
stockMovementSchema.index({ merchantId: 1, productId: 1, at: -1 });
// Reporting: sales over time / peak hours (Slice 4).
stockMovementSchema.index({ eventId: 1, reason: 1, at: -1 });
// Provenance ("the movement for this charge/transfer/count").
stockMovementSchema.index({ refType: 1, refId: 1 });

export const StockMovement = mongoose.model<IStockMovement>('StockMovement', stockMovementSchema);
