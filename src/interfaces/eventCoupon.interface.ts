import { Document, Types } from 'mongoose';

export interface CouponSnapshot {
  redeemedAt?: Date;
  couponId: Types.ObjectId;
  code: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  discountAmount: number;
  originalAmount: number;
  ticketTypeId: string;
}

export interface IEventCoupon extends Document {
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;
  code: string;
  label: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  ticketTypeIds: string[];
  expiresAt?: Date;
  disabled: boolean;
  // One exclusive checkout. Kept forever after payment; only a definitively
  // FAILED sale can release it. A clock alone never proves payment failed.
  saleId: Types.ObjectId | null;
  createdAt: Date;
}
