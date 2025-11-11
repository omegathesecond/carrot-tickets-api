import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IVendor, VerificationStatus } from '@interfaces/vendor.interface';

const vendorSchema = new Schema<IVendor>({
  // Authentication - Email OR Phone (both optional but at least one required)
  email: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
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
vendorSchema.index({ email: 1 });
vendorSchema.index({ phoneNumber: 1 });
vendorSchema.index({ slug: 1 });
vendorSchema.index({ isActive: 1, isVerified: 1 });
vendorSchema.index({ keshlessVendorId: 1 });

export const Vendor = mongoose.model<IVendor>('Vendor', vendorSchema);
