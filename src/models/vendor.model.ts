import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IVendor, VerificationStatus, OperatorType } from '@interfaces/vendor.interface';
import { STARTING_PRICE_UNITS } from '@/constants/serviceCategories';

const vendorSchema = new Schema<IVendor>({
  // Authentication - Email OR Phone (both optional but at least one required)
  email: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true,
    match: [/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, 'Please enter a valid email']
  },
  phoneNumber: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    select: false // Don't include in queries by default
  },

  // Business Information
  businessName: {
    type: String,
    required: [true, 'Business name is required'],
    trim: true,
    maxlength: [100, 'Business name cannot exceed 100 characters'],
    index: true
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  businessType: {
    type: String,
    enum: ['event_organizer', 'venue', 'promoter', 'entertainment', 'sports', 'other'],
    default: 'other',
    trim: true
  },
  operatorType: {
    type: String,
    enum: Object.values(OperatorType),
    default: OperatorType.EVENTS,
    index: true,
  },
  logoUrl: {
    type: String,
    trim: true,
    maxlength: [500, 'Logo URL cannot exceed 500 characters']
  },
  bio: {
    type: String,
    trim: true,
    maxlength: [500, 'Bio cannot exceed 500 characters']
  },

  // Service business (operatorType 'services') — the vertical of the supplier.
  // A plain validated string, NOT a Mongoose enum: categories are now DB-driven
  // (see ServiceCategory model / ServiceCategoryService), so the set of valid
  // values can change without a code deploy. Membership in the active category
  // set is checked at signup by ServiceCategoryService.isValidActive
  // (TicketsAuthService.registerBusiness), not enforced here at the schema level.
  serviceCategory: {
    type: String,
    trim: true,
    required: [
      function (this: IVendor) { return this.operatorType === OperatorType.SERVICES; },
      'A service category is required for service businesses',
    ],
    index: true,
  },
  startingPrice: {
    type: new Schema(
      { amountCents: {
          type: Number, min: 0, required: true,
          validate: { validator: Number.isInteger, message: 'amountCents must be a whole number of cents' },
        },
        unit: { type: String, enum: STARTING_PRICE_UNITS, default: 'day' } },
      { _id: false },
    ),
    required: false,
  },

  primaryContact: {
    type: String,
    trim: true,
    maxlength: [100, 'Primary contact name cannot exceed 100 characters']
  },

  // Contact Information
  address: {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    region: { type: String, trim: true },
    country: { type: String, default: 'SZ', uppercase: true },
    postalCode: { type: String, trim: true }
  },

  // Nearby opt-in — a real single-nested subdocument WITHOUT a default (same
  // reasoning as Buyer.location): a plain nested-path definition would seed
  // `{}` on every vendor and defeat the sparse 2dsphere index below. Kept
  // `undefined` until PATCH /api/tickets/social/me/location sets it.
  location: {
    type: new Schema(
      {
        type: { type: String, enum: ['Point'], required: true },
        coordinates: { type: [Number], required: true },
      },
      { _id: false }
    ),
    required: false,
  },
  locationUpdatedAt: { type: Date },

  // Verification Status
  verificationStatus: {
    type: String,
    enum: Object.values(VerificationStatus),
    default: VerificationStatus.PENDING,
    index: true
  },
  verifiedAt: {
    type: Date
  },
  rejectionReason: {
    type: String,
    maxlength: 500
  },

  // Keshless Integration
  keshlessVendorId: {
    type: String,
    sparse: true,
    trim: true,
    index: true
  },

  // Account Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isVerified: {
    type: Boolean,
    default: false,
    index: true
  },
  isSuperAdmin: {
    type: Boolean,
    default: false,
    index: true
  },

  // App Access Control
  apps: {
    keshless: {
      enabled: {
        type: Boolean,
        default: true
      },
      activatedAt: {
        type: Date,
        default: Date.now
      }
    },
    tickets: {
      enabled: {
        type: Boolean,
        default: true
      },
      activatedAt: {
        type: Date,
        default: Date.now
      }
    }
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(_doc, ret) {
      const { password, __v, ...rest } = ret;
      return rest;
    }
  },
  toObject: {
    transform: function(_doc, ret) {
      const { password, __v, ...rest } = ret;
      return rest;
    }
  }
});

// Helper function to generate slug from business name
function generateSlug(businessName: string): string {
  return businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, '') // Trim hyphens from start/end
    .slice(0, 30); // Max 30 chars
}

// Pre-save hook to hash password and generate slug
vendorSchema.pre('save', async function(next) {
  try {
    // Generate slug if new vendor or businessName changed
    if (this.isNew || this.isModified('businessName')) {
      const baseSlug = generateSlug(this.businessName);
      let slug = baseSlug;
      let counter = 1;

      // Ensure slug is unique
      const Vendor = this.constructor as any;
      while (await Vendor.findOne({ slug, _id: { $ne: this._id } })) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      this.slug = slug;
    }

    // Hash password if modified
    if (this.isModified('password')) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }

    next();
  } catch (error) {
    next(error as Error);
  }
});

// Method to compare passwords
vendorSchema.methods.comparePassword = async function(this: IVendor, candidatePassword: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, (this as any).password);
  } catch (error) {
    return false;
  }
};

// Indexes
// NOTE: email / phoneNumber / slug / keshlessVendorId declare their own
// single-field indexes on the field (unique + sparse / unique + index / sparse
// + index). Re-declaring them here produced a second "<field>_1" WITHOUT those
// options, which MongoDB rejects — silently, since Mongoose builds indexes in
// the background. Only compound indexes belong here.
vendorSchema.index({ isActive: 1, isVerified: 1 });
// NOTE: keshlessVendorId is intentionally NOT re-declared here — the field
// (above) already declares its own sparse single-field index. Re-declaring it
// produced a second, non-sparse "keshlessVendorId_1" that MongoDB rejects as a
// name/options conflict (it silently blocked index builds in prod and broke the
// whole test suite's shared DB setup). Carrot no longer depends on Keshless, so
// this link field is legacy; the field-level sparse index is all lookups need.
// Sparse by nature: a 2dsphere index only covers docs that actually have the
// geo field, so brands that never opted into location sharing are excluded.
vendorSchema.index({ location: '2dsphere' });

export const Vendor = mongoose.model<IVendor>('Vendor', vendorSchema);
