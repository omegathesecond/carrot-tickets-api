// api/src/interfaces/cashier.interface.ts
import { Document, Types } from 'mongoose';

/**
 * A Cashier works the money desk INSIDE the venue for an organizer — topping
 * up and CASHING OUT attendee wallets. Deliberately its OWN actor (mirroring
 * GateOperator), NOT a reseller: a "reseller" is an external ticket outlet
 * (e.g. Shoprite); a cashier is the organizer's in-venue staff. No "reseller"
 * naming may leak onto this actor (client requirement, 2026-08-11).
 */
export type CashierScope = 'platform' | 'organizer';

export interface ICashier extends Document {
  fullName: string;
  phoneNumber?: string;
  loginCode: string;
  pin: string;
  scope: CashierScope;
  /** The organizer (stored as a Vendor) this cashier works for; unset when platform-scoped. */
  vendorId?: Types.ObjectId;
  /** Events this cashier may work. EMPTY = every event of their organizer. */
  eventIds: Types.ObjectId[];
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  comparePin(candidate: string): Promise<boolean>;
}

/**
 * Cashier-scoped permissions. Deliberately a small, self-contained set (NOT
 * folded into the events/transport TicketsPermission partition) — a cashier
 * only moves wallet money and reads its own desk activity.
 */
export enum CashierPermission {
  CASH_TOPUP = 'cashier:cash_topup',
  CASH_WITHDRAW = 'cashier:cash_withdraw',
  VIEW_EVENTS = 'cashier:view_events',
  VIEW_OWN_TRANSACTIONS = 'cashier:view_own_transactions',
}

/** Every permission a cashier holds — top up, cash out, list events, see own desk. */
export const CASHIER_PERMISSIONS: CashierPermission[] = [
  CashierPermission.VIEW_EVENTS,
  CashierPermission.CASH_TOPUP,
  CashierPermission.CASH_WITHDRAW,
  CashierPermission.VIEW_OWN_TRANSACTIONS,
];

/** JWT payload minted by CashierAuthService.login and verified by authenticateCashier. */
export interface CashierToken {
  scope: 'cashier';
  cashierId: string;
  /** The organizer this cashier works for; absent for platform-scoped cashiers. */
  vendorId?: string;
  isSuperAdmin: boolean;
  fullName: string;
  permissions: CashierPermission[];
}
