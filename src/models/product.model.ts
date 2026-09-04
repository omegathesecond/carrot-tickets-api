import mongoose, { Schema, Document } from 'mongoose';
import { ProductCategory } from '@interfaces/stock.interface';

/**
 * A sellable catalogue item at ONE cashless event (design §4). Price is per
 * base unit in ZAR cents. `unitsPerPack` drives case<->unit conversion at the
 * entry/display boundary; stock itself is always base units. `barcode` is the
 * manufacturer EAN/UPC — unique per event, but optional (food/ice/cups have none).
 */
export interface IProduct extends Document {
  eventId: mongoose.Types.ObjectId;
  name: string;
  barcode?: string;
  category: ProductCategory;
  price: number; // integer ZAR cents, per base unit
  unitLabel: string;
  unitsPerPack?: number;
  packLabel?: string;
  imageUrl?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    name: { type: String, required: true, trim: true },
    barcode: { type: String, trim: true },
    category: { type: String, enum: Object.values(ProductCategory), required: true },
    price: {
      type: Number, required: true, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'price must be integer minor units (ZAR cents)' },
    },
    unitLabel: { type: String, default: 'unit', trim: true },
    unitsPerPack: { type: Number, min: 1, validate: { validator: (v: number) => v == null || Number.isSafeInteger(v), message: 'unitsPerPack must be a whole number' } },
    packLabel: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

// Unique barcode per event, but ONLY for products that HAVE a barcode.
// partialFilterExpression (not sparse): a compound sparse index still indexes
// every doc because eventId is always present, so barcode:null would collide
// across barcodeless products in the same event (the E11000 {null} incident).
productSchema.index(
  { eventId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);

export const Product = mongoose.model<IProduct>('Product', productSchema);
