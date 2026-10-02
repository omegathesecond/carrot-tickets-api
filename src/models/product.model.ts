import mongoose, { Schema, Document } from 'mongoose';
import { ProductCategory } from '@interfaces/stock.interface';
import { applyTradingScope } from '@models/tradingScope.schema';

/**
 * A sellable catalogue item at ONE cashless event (design §4). Price is per
 * base unit in ZAR cents. `unitsPerPack` drives case<->unit conversion at the
 * entry/display boundary; stock itself is always base units. `barcode` is the
 * manufacturer EAN/UPC — unique per event, but optional (food/ice/cups have none).
 */
export interface IProduct extends Document {
  /** Exactly one of eventId / venueId is set (applyTradingScope). */
  eventId?: mongoose.Types.ObjectId;
  venueId?: mongoose.Types.ObjectId;
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
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
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

applyTradingScope(productSchema);

// Unique barcode per OWNER (event or venue), only for products that HAVE one.
// The legacy `eventId_1_barcode_1` indexed a venue product's missing eventId as
// null, so the same barcode at two venues collided. These replace it under NEW
// names and a reversed key order, so they can be built beside the legacy index
// on any MongoDB version (no same-name or same-key-pattern conflict);
// scripts/migrate-product-barcode-index.ts then drops the legacy one.
// partialFilterExpression (not sparse): see the {null} collision noted above.
productSchema.index(
  { barcode: 1, eventId: 1 },
  {
    name: 'event_barcode_unique',
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string' }, eventId: { $exists: true } },
  },
);
productSchema.index(
  { barcode: 1, venueId: 1 },
  {
    name: 'venue_barcode_unique',
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string' }, venueId: { $exists: true } },
  },
);

// The venue catalogue list query (the unique-barcode index above is event-led).
productSchema.index({ venueId: 1, active: 1 });

export const Product = mongoose.model<IProduct>('Product', productSchema);
