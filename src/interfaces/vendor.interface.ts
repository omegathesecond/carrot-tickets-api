import { Document, Types } from 'mongoose';

export enum VerificationStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended'
}

export enum OperatorType {
  EVENTS = 'events',
  TRANSPORT = 'transport',
  BOTH = 'both',
}

/**
 * What kind of brand this Vendor document represents. ORGANIZER is the
 * original/default meaning (runs ticketed events, self-service signup lives
 * in the dashboard app). BUSINESS is an event-services supplier (sound hire,
 * catering, decor, ...) who never sells tickets — self-service signup lives
 * on the public site's buyer-facing "Tickets" screen instead. The two share
 * the Vendor account/auth/social plumbing; serviceCategory only applies to
 * BUSINESS.
 */
export enum AccountKind {
  ORGANIZER = 'organizer',
  BUSINESS = 'business',
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
  operatorType: OperatorType;
  accountKind: AccountKind;
  // Event-services category (Sound Hire, Catering, ...) — set only when
  // accountKind is BUSINESS. See @constants/businessCategories.
  serviceCategory?: string;
  primaryContact?: string;
  logoUrl?: string;
  bio?: string;

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
  isSuperAdmin?: boolean; // System-wide admin access

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
