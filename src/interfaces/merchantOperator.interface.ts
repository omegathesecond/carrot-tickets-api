// api/src/interfaces/merchantOperator.interface.ts
import { Document, Types } from 'mongoose';

/**
 * One PERSON working a stall. The stall itself is a Merchant: it holds the
 * name, the commission rate and the settlement account, but no credentials —
 * a place does not log in. Everyone on the till gets their own operator so a
 * charge names a human, and so one person can be revoked without rotating
 * the whole stall's PIN.
 */
export interface IMerchantOperator extends Document {
  fullName: string;
  phoneNumber?: string;
  /** The stall this person works. Immutable — move = new operator. */
  merchantId: Types.ObjectId;
  /** Denormalized from the stall so token minting needs no join. */
  eventId: Types.ObjectId;
  loginCode: string;
  pin: string;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  comparePin(candidate: string): Promise<boolean>;
}
