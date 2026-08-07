// api/src/interfaces/merchant.interface.ts
import { Document, Types } from 'mongoose';

export type MerchantStatus = 'active' | 'suspended';

export interface IMerchant extends Document {
  name: string;
  /** The event this merchant sells at — a merchant is scoped to ONE event. */
  eventId: Types.ObjectId;
  /** Platform commission taken off every charge, 0-100. Defaults to 0 (no cut). */
  commissionPercent: number;
  loginCode: string;
  pin: string;
  status: MerchantStatus;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  comparePin(candidate: string): Promise<boolean>;
}

/** Permission namespace for merchant-scoped tokens, mirroring ResellerPermission. */
export enum MerchantPermission {
  CHARGE = 'merchant:charge',
}

/** JWT payload shape minted by MerchantAuthService.login and verified by authenticateMerchant. */
export interface MerchantToken {
  scope: 'merchant';
  merchantId: string;
  eventId: string;
  name: string;
  /** The event's display name, for UI headers (e.g. the vendor/POS chrome) — optional so older tokens without it still verify. */
  eventName?: string;
  permissions: MerchantPermission[];
}
