import mongoose, { Schema } from 'mongoose';
import { ITicketSale, PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

const ticketSaleSchema = new Schema<ITicketSale>({
  // Sale Identification
  saleId: {
    type: String,
    unique: true,
    index: true
  },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    required: [true, 'Event ID is required'],
    index: true
  },
  vendorId: {
    type: Schema.Types.ObjectId,
    ref: 'Vendor',
    required: [true, 'Vendor ID is required'],
    index: true
  },

  // Tickets Sold
  ticketIds: [{
    type: Schema.Types.ObjectId,
    ref: 'Ticket',
    required: true
  }],
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },

  // Customer Info
  customerName: {
    type: String,
    trim: true,
    maxlength: [100, 'Customer name cannot exceed 100 characters']
  },
  customerPhone: {
    type: String,
    trim: true
  },
  customerUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Keshless user
    sparse: true
  },

  // Payment
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0, 'Total amount cannot be negative']
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PaymentMethod),
    required: [true, 'Payment method is required'],
    index: true
  },
  paymentStatus: {
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
    index: true
  },
  walletTransactionId: {
    type: String,
    sparse: true,
    trim: true
  },
  momoReferenceId: {
    type: String,
    sparse: true,
    index: true,
    trim: true
  },
  reservationExpiresAt: {
    type: Date,
    index: true
  },

  // Staff
  soldBy: {
    type: Schema.Types.ObjectId,
    required: [true, 'Seller ID is required'],
    refPath: 'soldByType'
  },
  soldByType: {
    type: String,
    required: true,
    enum: ['Vendor', 'VendorSubUser', 'ResellerOperator'],
    default: 'Vendor'
  },

  // Sales channel — "where bought"
  channel: {
    type: String,
    enum: Object.values(SalesChannel),
    index: true
  },

  // Reseller Attribution
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', index: true, sparse: true },
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', index: true, sparse: true },

  // Economic snapshot — immutable, written at sale time
  faceAmount: { type: Number },
  resellerCommissionPercent: { type: Number, default: 0 },
  resellerCommissionAmount: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
  platformFeeAmount: { type: Number, default: 0 },
  organizerProceeds: { type: Number },
  fundsCustody: { type: String, enum: ['carrot', 'reseller', 'vendor'] },

  // Set true when the covering reseller settlement is closed + paid
  resellerRemitted: { type: Boolean, default: false, index: true },
  commissionWithdrawn: { type: Boolean, default: false, index: true },

  // Timestamps
  soldAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Pre-save hook to generate saleId
ticketSaleSchema.pre('save', function(next) {
  if (this.isNew && !this.saleId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9).toUpperCase();
    this.saleId = `SALE-${timestamp}-${random}`;
  }
  next();
});

// Indexes
ticketSaleSchema.index({ vendorId: 1, soldAt: -1 });
ticketSaleSchema.index({ eventId: 1, soldAt: -1 });
ticketSaleSchema.index({ paymentStatus: 1, paymentMethod: 1 });
ticketSaleSchema.index({ soldBy: 1, soldByType: 1 });
ticketSaleSchema.index({ customerUserId: 1 });
ticketSaleSchema.index({ channel: 1, soldAt: -1 });

export const TicketSale = mongoose.model<ITicketSale>('TicketSale', ticketSaleSchema);
