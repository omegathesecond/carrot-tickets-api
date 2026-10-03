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
  /** The event OR venue this stall trades at — exactly one of eventId / venueId is set (applyTradingScope). */
  eventId?: Types.ObjectId;
  venueId?: Types.ObjectId;
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
  /** The stall's display name. */
  name: string;
  /** Exactly one of eventId / venueId — the stall's owner. */
  eventId?: string;
  /** The event's display name, for UI headers (event tills). */
  eventName?: string;
  venueId?: string;
  /** The venue's display name, for UI headers (venue tills). */
  venueName?: string;
  permissions: MerchantPermission[];
}
