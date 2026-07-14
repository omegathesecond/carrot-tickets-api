import { Document, Types } from 'mongoose';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

export enum BookingStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  BOARDED = 'boarded',
  NO_SHOW = 'no_show',
}

export enum BoardingScanResult {
  SUCCESS = 'success',
  ALREADY_BOARDED = 'already_boarded',
  WRONG_TRIP = 'wrong_trip',
  CANCELLED_BOOKING = 'cancelled_booking',
  INVALID = 'invalid',
}

export interface IBooking extends Document {
  _id: Types.ObjectId;
  bookingRef: string;
  qrCode: string;
  tripId: Types.ObjectId;
  vendorId: Types.ObjectId;
  passengerName: string;
  passengerPhone: string;
  seatNumber?: string; // null for PASSENGER_COUNT trips
  fareAmount: number;
  platformFee: number;
  totalAmount: number;
  saleId?: Types.ObjectId; // ref BookingSale
  purchasedBy?: Types.ObjectId;
  status: BookingStatus;
  boardedAt?: Date;
  boardedBy?: Types.ObjectId;
  cancelledAt?: Date;
  refundedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBookingSale extends Document {
  _id: Types.ObjectId;
  saleRef: string;
  tripId: Types.ObjectId;
  vendorId: Types.ObjectId;
  bookingIds: Types.ObjectId[];
  quantity: number;
  customerName?: string;
  customerPhone?: string;
  customerUserId?: Types.ObjectId;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  walletTransactionId?: string;
  momoReferenceId?: string;
  momoFailureReason?: string;
  peachPaymentId?: string;
  reservationExpiresAt?: Date;
  soldBy: Types.ObjectId;
  soldByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator';
  channel: SalesChannel;
  resellerId?: Types.ObjectId;
  hubId?: Types.ObjectId;
  faceAmount?: number;
  resellerCommissionPercent?: number;
  resellerCommissionAmount?: number;
  platformFeePercent?: number;
  platformFeeAmount?: number;
  serviceFeeAmount?: number;
  amountCharged?: number;
  organizerProceeds?: number;
  fundsCustody?: 'carrot' | 'reseller' | 'vendor';
  soldAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBoardingScan extends Document {
  _id: Types.ObjectId;
  bookingId?: Types.ObjectId;
  tripId: Types.ObjectId;
  vendorId?: Types.ObjectId;
  scannedBy: Types.ObjectId;
  scannedByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator';
  result: BoardingScanResult;
  notes?: string;
  scannedAt: Date;
  createdAt: Date;
}
