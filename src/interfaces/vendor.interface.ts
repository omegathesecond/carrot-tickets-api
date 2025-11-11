import { Document, Types } from 'mongoose';

export enum VerificationStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended'
}

export interface IVendor extends Document {
  _id: Types.ObjectId;

  // Authentication
  email?: string;
  phoneNumber?: string;
  password: string;

  // Business Information
  businessName: string;
  slug: string;
  businessType?: string;
  primaryContact?: string;

  // Contact Information
  address?: {
    street?: string;
    city?: string;
    region?: string;
    country?: string;
    postalCode?: string;
  };

  // Verification
  verificationStatus: VerificationStatus;
  verifiedAt?: Date;
  rejectionReason?: string;

  // Keshless Vendor Link (for payments)
  keshlessVendorId?: string; // Link to main Keshless vendor account

  // Account Status
  isActive: boolean;
  isVerified: boolean;

  // App Access
  apps: {
    keshless: {
      enabled: boolean;
      activatedAt?: Date;
    };
    tickets: {
      enabled: boolean;
      activatedAt?: Date;
    };
  };

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  comparePassword(candidatePassword: string): Promise<boolean>;
}
