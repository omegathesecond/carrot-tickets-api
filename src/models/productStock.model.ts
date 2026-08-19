import mongoose, { Schema, Document } from 'mongoose';

/**
 * Per-BAR on-hand count for one product (design §4). `onHand` is the
 * denormalized, authoritative count and the atomic CAS source for the
 * hard-block-at-zero sale (Slice 2). It is mutated ONLY by
 * StockService.applyMovement, which keeps it equal to the sum of this
 * bar-product's StockMovement deltas.
 */
export interface IProductStock extends Document {
  eventId: mongoose.Types.ObjectId;
  merchantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  onHand: number; // integer base units, >= 0
  lowStockThreshold?: number;
  lowStockAlertedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const productStockSchema = new Schema<IProductStock>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    onHand: {
      type: Number, default: 0, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'onHand must be a whole number of base units' },
    },
    lowStockThreshold: { type: Number, min: 0 },
    lowStockAlertedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One stock row per bar-product; also the lookup key for the sale CAS.
productStockSchema.index({ merchantId: 1, productId: 1 }, { unique: true });
// Aggregate one product across all bars ("Castle Lite across the event").
productStockSchema.index({ eventId: 1, productId: 1 });

export const ProductStock = mongoose.model<IProductStock>('ProductStock', productStockSchema);
