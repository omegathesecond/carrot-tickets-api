// api/src/interfaces/merchant.interface.ts
import { Document, Types } from 'mongoose';

export type MerchantStatus = 'active' | 'suspended';

/**
 * A STALL at one cashless event — its identity, its commission rate and, via
 * LedgerAccountType.MERCHANT, the account money is owed to. It holds NO
 * credentials: a place does not log in. The people working the till are
 * MerchantOperator documents, each with their own loginCode + PIN.
 */
export interface IMerchant extends Document {
  name: string;
  /** The event this merchant sells at — a merchant is scoped to ONE event. */
  eventId: Types.ObjectId;
  /** Platform commission taken off every charge, 0-100. Defaults to 0 (no cut). */
  commissionPercent: number;
  status: MerchantStatus;
}

/** Permission namespace for merchant-scoped tokens, mirroring ResellerPermission. */
export enum MerchantPermission {
  CHARGE = 'merchant:charge',
  /** Receive, write off and transfer THIS stall's stock (OperatorGrant.MANAGE_STOCK). */
  MANAGE_STOCK = 'merchant:manage_stock',
}

/** JWT payload minted by MerchantAuthService.login and verified by authenticateMerchant. */
export interface MerchantToken {
  scope: 'merchant';
  /** The STALL — what money is owed to, and what charges are indexed by. */
  merchantId: string;
  /** The PERSON on the till — what each charge is attributed to. */
  merchantOperatorId: string;
  operatorName: string;
  eventId: string;
  /** The stall's display name. */
  name: string;
  /** The event's display name, for UI headers (e.g. the vendor/POS chrome). */
  eventName?: string;
  permissions: MerchantPermission[];
}
