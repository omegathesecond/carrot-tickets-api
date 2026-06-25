// api/src/interfaces/gateOperator.interface.ts
import { Document, Types } from 'mongoose';

export type GateOperatorScope = 'platform' | 'organizer';

export interface IGateOperator extends Document {
  fullName: string;
  phoneNumber?: string;
  loginCode: string;
  pin: string;
  scope: GateOperatorScope;
  vendorId?: Types.ObjectId;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt?: Date;
  comparePin(candidate: string): Promise<boolean>;
}
