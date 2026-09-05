import { Document, Types } from 'mongoose';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

/**
 * A Waiter works the FLOOR for an organizer: opens a table, collects items
 * from several stalls onto it, and settles it at the end. Its own actor,
 * mirroring Cashier — NOT a MerchantOperator with a grant, because that actor
 * is scoped to exactly one stall and crossing stalls is this job's whole point.
 */
export type WaiterScope = 'platform' | 'organizer';

export interface IWaiter extends Document {
  fullName: string;
  phoneNumber?: string;
  loginCode: string;
  pin: string;
  scope: WaiterScope;
  vendorId?: Types.ObjectId;
  /** The single event this waiter works. Unset only for platform scope. */
  eventId?: Types.ObjectId;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  /** Inherited from applyOperatorCredentials. Only SETTLE_TABLES uses one today. */
  grants?: OperatorGrant[];
  comparePin(candidate: string): Promise<boolean>;
}

export enum WaiterPermission {
  VIEW_EVENTS = 'waiter:view_events',
  MANAGE_TABLES = 'waiter:manage_tables',
  /** The money moment — granted per person, so absent from WAITER_PERMISSIONS. */
  SETTLE_TABLES = 'waiter:settle_tables',
}

/** Every permission a waiter holds without an extra grant. */
export const WAITER_PERMISSIONS: WaiterPermission[] = [
  WaiterPermission.VIEW_EVENTS,
  WaiterPermission.MANAGE_TABLES,
];

/** JWT payload minted by WaiterAuthService.login, verified by authenticateWaiter. */
export interface WaiterToken {
  scope: 'waiter';
  userType: 'waiter';
  waiterId: string;
  role: 'waiter';
  permissions: WaiterPermission[];
  isSuperAdmin: boolean;
  fullName: string;
  vendorId?: string;
  eventId?: string;
}
