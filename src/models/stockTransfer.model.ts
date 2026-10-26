// src/models/stockTransfer.model.ts
import mongoose, { Schema, Document } from 'mongoose';
import { StockMovementByType } from '@interfaces/stock.interface';

/** A bar-to-bar stock move (design §3). The two paired StockMovements
 *  (TRANSFER_OUT/TRANSFER_IN, refId = this _id) carry the ledger effect; this
 *  row is the human-facing audit (who moved what, from/to which bar, when). */
export interface IStockTransfer extends Document {
  eventId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  fromMerchantId: mongoose.Types.ObjectId;
  toMerchantId: mongoose.Types.ObjectId;
  qty: number;
  /**
   * Narrower than a movement's: a waiter never writes a transfer (or a count).
   * They pour from one stall's shelf onto a tab, which is a SALE movement — no
   * bar-to-bar move and no stock-take. Typing the field as the full alias while
   * the schema enum below lists only three values would let a 'Waiter' transfer
   * compile and then die on schema validation at runtime.
   */
  byType: Exclude<StockMovementByType, 'Waiter'>;
  by: string;
  note?: string;
  at: Date;
}

const stockTransferSchema = new Schema<IStockTransfer>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  fromMerchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  toMerchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  qty: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'qty must be a whole number' } },
  byType: { type: String, enum: ['Organizer', 'Merchant', 'Platform'], required: true },
  by: { type: String, required: true },
  note: { type: String, trim: true },
  at: { type: Date, default: Date.now },
}, { timestamps: false });

stockTransferSchema.index({ eventId: 1, at: -1 });
stockTransferSchema.index({ productId: 1, at: -1 });

export const StockTransfer = mongoose.model<IStockTransfer>('StockTransfer', stockTransferSchema);
