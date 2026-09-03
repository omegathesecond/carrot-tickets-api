import mongoose, { Schema, Document, Types } from 'mongoose';

export enum MenuSection {
  BAR = 'bar',
  VENDOR = 'vendor',
}

/**
 * A preorderable item on an event's Menu tab — either the venue's own bar
 * menu or a food/vendor stall's menu. `category` is a free-text grouping
 * (e.g. "Cognac", "Starters") shown as a sub-heading, mirroring how the
 * cashless Product catalogue groups by ProductCategory but without a fixed
 * enum, since vendor menus vary far more than a bar's drink list.
 */
export interface IMenuItem extends Document {
  eventId: Types.ObjectId;
  section: MenuSection;
  // Which food/vendor stall this item belongs to. Only meaningful when
  // section === VENDOR — the bar menu is the organizer's own, unattributed.
  vendorName?: string;
  category: string;
  name: string;
  description?: string;
  price: number; // integer minor units (cents), same convention as Product.price
  imageUrl?: string;
  active: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const menuItemSchema = new Schema<IMenuItem>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    section: { type: String, enum: Object.values(MenuSection), required: true },
    vendorName: { type: String, trim: true },
    category: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 500 },
    price: {
      type: Number, required: true, min: 0,
      validate: { validator: Number.isSafeInteger, message: 'price must be integer minor units' },
    },
    imageUrl: { type: String, trim: true },
    active: { type: Boolean, default: true, index: true },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

menuItemSchema.index({ eventId: 1, section: 1, category: 1, displayOrder: 1 });

export const MenuItem = mongoose.model<IMenuItem>('MenuItem', menuItemSchema);
