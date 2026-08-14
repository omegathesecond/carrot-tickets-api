import { Schema, model, Document } from 'mongoose';

/**
 * A service-business category (sound hire, catering, decor, ...) — DB-driven
 * replacement for the previously hardcoded SERVICE_CATEGORIES constant
 * (src/constants/serviceCategories.ts, still the seed source — see
 * src/scripts/seed-service-categories.ts). Lets an admin add/rename/retire a
 * category with no code deploy. `value` is the stable identifier stored on
 * Vendor.serviceCategory and matched by the /services directory's
 * `?category=` filter; `label` is the display string shown in pickers.
 *
 * A category is never hard-deleted — `isActive: false` retires it: it drops
 * out of the public listActive() picker and fails
 * ServiceCategoryService.isValidActive(), but existing vendors already on
 * that category keep their (now-unlisted) value untouched.
 */
export interface IServiceCategory extends Document {
  value: string;
  label: string;
  icon?: string;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const serviceCategorySchema = new Schema<IServiceCategory>(
  {
    value: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    icon: {
      type: String,
      trim: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Powers listActive()'s "active categories, sorted by order" query.
serviceCategorySchema.index({ isActive: 1, order: 1 });

export const ServiceCategory = model<IServiceCategory>('ServiceCategory', serviceCategorySchema);
