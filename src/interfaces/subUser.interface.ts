import { Document, Types } from 'mongoose';

export enum SubUserRole {
  MANAGER = 'manager', // Full access to all features
  SALES = 'sales', // Can sell tickets and view sales
  SCANNER = 'scanner' // Can only scan/validate tickets
}

export enum Permission {
  // Event Management
  EVENT_CREATE = 'event:create',
  EVENT_EDIT = 'event:edit',
  EVENT_DELETE = 'event:delete',
  EVENT_PUBLISH = 'event:publish',
  EVENT_VIEW = 'event:view',

  // Ticket Sales
  TICKET_SELL = 'ticket:sell',
  TICKET_REFUND = 'ticket:refund',
  TICKET_VIEW = 'ticket:view',

  // Entry Validation
  TICKET_SCAN = 'ticket:scan',

  // Analytics
  ANALYTICS_VIEW = 'analytics:view',
  ANALYTICS_EXPORT = 'analytics:export',

  // Staff Management
  STAFF_MANAGE = 'staff:manage',
  STAFF_VIEW = 'staff:view',

  // Settings
  SETTINGS_MANAGE = 'settings:manage'
}

export interface IVendorSubUser extends Document {
  _id: Types.ObjectId;

  // Authentication
  email?: string;
  phoneNumber?: string;
  password: string;

  // Personal Info
  fullName: string;

  // Vendor Association
  vendorId: Types.ObjectId;

  // Role & Permissions
  role: SubUserRole;
  permissions: Permission[];

  // Account Status
  isActive: boolean;

  // First Login
  firstLogin: boolean;
  mustChangePassword: boolean;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;

  // Methods
  comparePassword(candidatePassword: string): Promise<boolean>;
  hasPermission(permission: Permission): boolean;
}
