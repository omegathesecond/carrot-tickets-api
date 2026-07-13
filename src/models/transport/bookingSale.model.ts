import mongoose, { Schema } from 'mongoose';
import { IBookingSale } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const bookingSaleSchema = new Schema<IBookingSale>({
  saleRef: { type: String, unique: true, index: true },
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  bookingIds: [{ type: Schema.Types.ObjectId, ref: 'Booking', required: true }],
  quantity: { type: Number, required: true, min: 1 },
  customerName: { type: String, trim: true },
  customerPhone: { type: String, trim: true },
  customerUserId: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
  totalAmount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true, index: true },
  paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING, index: true },
  walletTransactionId: { type: String, trim: true, sparse: true },
  momoReferenceId: { type: String, trim: true, sparse: true, index: true },
  momoFailureReason: { type: String, trim: true },
  peachPaymentId: { type: String, trim: true, sparse: true, index: true },
  reservationExpiresAt: { type: Date, index: true },
  soldBy: { type: Schema.Types.ObjectId, required: true, refPath: 'soldByType' },
  soldByType: { type: String, required: true, enum: ['Vendor', 'VendorSubUser', 'ResellerOperator'], default: 'ResellerOperator' },
  channel: { type: String, enum: Object.values(SalesChannel), index: true },
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', index: true, sparse: true },
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', index: true, sparse: true },
  faceAmount: { type: Number },
  resellerCommissionPercent: { type: Number, default: 0 },
  resellerCommissionAmount: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
  platformFeeAmount: { type: Number, default: 0 },
  serviceFeeAmount: { type: Number, default: 0 },
  amountCharged: { type: Number },
  organizerProceeds: { type: Number },
  fundsCustody: { type: String, enum: ['carrot', 'reseller', 'vendor'] },
  soldAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

bookingSaleSchema.pre('save', function (next) {
  if (this.isNew && !this.saleRef) {
    const random = Math.random().toString(36).substring(2, 9).toUpperCase();
    this.saleRef = `BSALE-${Date.now()}-${random}`;
  }
  next();
});

bookingSaleSchema.index({ vendorId: 1, soldAt: -1 });
bookingSaleSchema.index({ tripId: 1, soldAt: -1 });

export const BookingSale = mongoose.model<IBookingSale>('BookingSale', bookingSaleSchema);
