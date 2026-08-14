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
  SERVICES = 'services',
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
  primaryContact?: string;
  logoUrl?: string;
  bio?: string;

  // Service business (operatorType 'services') — the vertical of the supplier.
  serviceCategory?: import('@/constants/serviceCategories').ServiceCategory;
  startingPrice?: { amountCents: number; unit: import('@/constants/serviceCategories').StartingPriceUnit };

  // Contact Information
  address?: {
    street?: string;
    city?: string;
    region?: string;
    country?: string;
    postalCode?: string;
  };

  // Nearby opt-in (v1) — a brand sharing its location so it can discover nearby
  // people (and, later, be discoverable itself). Mirrors Buyer.location:
  // GeoJSON Point with coordinates in [lng, lat] order, absent until the brand
  // opts in via PATCH /api/tickets/social/me/location (sparse 2dsphere index).
  location?: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  locationUpdatedAt?: Date;

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
