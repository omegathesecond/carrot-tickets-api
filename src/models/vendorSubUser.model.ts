import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IVendorSubUser, SubUserRole, Permission } from '@interfaces/subUser.interface';

const vendorSubUserSchema = new Schema<IVendorSubUser>({
  // Authentication
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
    select: false
  },

  // Personal Info
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true,
    maxlength: [100, 'Full name cannot exceed 100 characters']
  },

  // Vendor Association
  vendorId: {
    type: Schema.Types.ObjectId,
    ref: 'Vendor',
    required: [true, 'Vendor ID is required'],
    index: true
  },

  // Role & Permissions
  role: {
    type: String,
    enum: Object.values(SubUserRole),
    required: [true, 'Role is required'],
    index: true
  },
  permissions: {
    type: [String],
    enum: Object.values(Permission),
    default: []
  },

  // Account Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  // First Login
  firstLogin: {
    type: Boolean,
    default: true
  },
  mustChangePassword: {
    type: Boolean,
    default: true
  },

  // Tracking
  lastLoginAt: {
    type: Date
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

// Pre-save hook to hash password and set default permissions
vendorSubUserSchema.pre('save', async function(next) {
  try {
    // Hash password if modified
    if (this.isModified('password')) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }

    // Set default permissions based on role
    if (this.isNew || this.isModified('role')) {
      switch (this.role) {
        case SubUserRole.MANAGER:
          this.permissions = [
            Permission.EVENT_CREATE,
            Permission.EVENT_EDIT,
            Permission.EVENT_DELETE,
            Permission.EVENT_PUBLISH,
            Permission.EVENT_VIEW,
            Permission.TICKET_SELL,
            Permission.TICKET_REFUND,
            Permission.TICKET_VIEW,
            Permission.TICKET_SCAN,
            Permission.ANALYTICS_VIEW,
            Permission.ANALYTICS_EXPORT,
            Permission.STAFF_VIEW,
            Permission.SETTINGS_MANAGE
          ];
          break;

        case SubUserRole.SALES:
          this.permissions = [
            Permission.EVENT_VIEW,
            Permission.TICKET_SELL,
            Permission.TICKET_VIEW,
            Permission.ANALYTICS_VIEW
          ];
          break;

        case SubUserRole.SCANNER:
          this.permissions = [
            Permission.EVENT_VIEW,
            Permission.TICKET_SCAN,
            Permission.TICKET_VIEW
          ];
          break;

        default:
          this.permissions = [];
      }
    }

    next();
  } catch (error) {
    next(error as Error);
  }
});

// Method to compare passwords
vendorSubUserSchema.methods.comparePassword = async function(this: IVendorSubUser, candidatePassword: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, (this as any).password);
  } catch (error) {
    return false;
  }
};

// Method to check if user has a specific permission
vendorSubUserSchema.methods.hasPermission = function(this: IVendorSubUser, permission: Permission): boolean {
  return (this as any).permissions.includes(permission);
};

// Indexes
vendorSubUserSchema.index({ vendorId: 1, isActive: 1 });
vendorSubUserSchema.index({ email: 1 });
vendorSubUserSchema.index({ phoneNumber: 1 });

export const VendorSubUser = mongoose.model<IVendorSubUser>('VendorSubUser', vendorSubUserSchema);
