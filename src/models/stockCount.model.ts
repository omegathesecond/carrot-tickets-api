// src/models/stockCount.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { StockMovementByType } from '@interfaces/stock.interface';

export type StockCountPhase = 'opening' | 'interim' | 'closing';

/** A physical stock-take (design §3): expected (system onHand) vs counted, with
 *  the preserved variance; reconciled to reality via a COUNT_ADJUST movement. */
export interface IStockCount extends Document {
  eventId: mongoose.Types.ObjectId; merchantId: mongoose.Types.ObjectId; productId: mongoose.Types.ObjectId;
  expectedOnHand: number; countedOnHand: number; variance: number;   // counted − expected
  phase: StockCountPhase; byType: StockMovementByType; by: string; at: Date;
}

const stockCountSchema = new Schema<IStockCount>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  expectedOnHand: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'expectedOnHand must be a whole number' } },
  countedOnHand: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'countedOnHand must be a whole number' } },
  variance: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'variance must be a whole number' } },
  phase: { type: String, enum: ['opening', 'interim', 'closing'], default: 'interim' },
  byType: { type: String, enum: ['Organizer', 'Merchant', 'Platform'], required: true },
  by: { type: String, required: true },
  at: { type: Date, default: Date.now },
}, { timestamps: false });

stockCountSchema.index({ merchantId: 1, productId: 1, at: -1 });
stockCountSchema.index({ eventId: 1, phase: 1, at: -1 });

export const StockCount = mongoose.model<IStockCount>('StockCount', stockCountSchema);
