import { Document, Types } from 'mongoose';

export enum TicketStatus {
  AVAILABLE = 'available',
  SOLD = 'sold',
  CHECKED_IN = 'checked_in',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled'
}

export enum PaymentMethod {
  CASH = 'cash',
  KESHLESS_WALLET = 'keshless_wallet',
  MTN_MOMO = 'mtn_momo',
  PEACH_CARD = 'peach_card'
}

export enum PaymentStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded'
}

export enum SalesChannel {
  ONLINE = 'online',          // buyer self-service web/app checkout
  BOX_OFFICE = 'box_office',  // vendor/sub-user selling in person
  RESELLER_POS = 'reseller_pos' // reseller operator sale
}

export interface ITicket extends Document {
  _id: Types.ObjectId;

  // Ticket Identification
  ticketId: string; // TKT-{timestamp}-{random} - QR scannable
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;

  // Ticket Details
  ticketType: string; // VIP, Regular, etc.
  price: number;

  // Ownership
  purchasedBy?: Types.ObjectId; // User ID (if from Keshless app)
  customerName?: string; // For cash/walk-in purchases
  customerPhone?: string;
  saleId?: Types.ObjectId; // Link to sale transaction

  // Status
  status: TicketStatus;

  // Entry Tracking
  checkedInAt?: Date;
  checkedInBy?: Types.ObjectId; // Staff who scanned
  checkedInByModel?: string; // 'Vendor' or 'VendorSubUser'

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  checkIn(scannerId: string, scannerModel: string): Promise<ITicket>;
  isValidForEntry(): boolean;
}

export interface ITicketSale extends Document {
  _id: Types.ObjectId;

  // Sale Identification
  saleId: string; // SALE-{timestamp}-{random}
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;

  // Tickets Sold
  ticketIds: Types.ObjectId[]; // Array of ticket IDs
  quantity: number;

  // Customer Info
  customerName?: string;
  customerPhone?: string;
  customerUserId?: Types.ObjectId; // If purchased via Keshless app

  // Payment
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  walletTransactionId?: string; // Keshless transaction ID
  momoReferenceId?: string;      // MTN MoMo X-Reference-Id (UUID) for async collections
  momoFailureReason?: string;    // MTN failure reason enum (e.g. NOT_ENOUGH_FUNDS) for buyer messaging
  peachPaymentId?: string;       // Peach Payments payment ID for card transactions
  reservationExpiresAt?: Date;   // when a PENDING MoMo reservation lapses

  // Staff
  soldBy: Types.ObjectId; // Staff member who made the sale
  soldByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator'; // Who sold it

  // Sales channel — "where bought". Orthogonal to soldByType: a vendor sale can
  // be online OR box_office. Set at sale-build time; never null for new sales.
  channel: SalesChannel;

  // Reseller Attribution
  resellerId?: Types.ObjectId;
  hubId?: Types.ObjectId;

  // Economic Snapshot — immutable, written at sale time
  faceAmount?: number;
  resellerCommissionPercent?: number;
  resellerCommissionAmount?: number;
  platformFeePercent?: number;
  platformFeeAmount?: number;
  serviceFeeAmount?: number;
  amountCharged?: number;
  organizerProceeds?: number;
  fundsCustody?: 'carrot' | 'reseller' | 'vendor';

  // Set true when the covering reseller settlement is closed + paid
  resellerRemitted: boolean;
  commissionWithdrawn?: boolean;

  // Timestamps
  soldAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITicketScan extends Document {
  _id: Types.ObjectId;

  // Scan Details
  ticketId: Types.ObjectId;
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;

  // Scanner Info
  scannedBy: Types.ObjectId;
  scannedByType: 'Vendor' | 'VendorSubUser' | 'GateOperator';

  // Scan Result
  isValid: boolean;
  scanResult: 'success' | 'already_scanned' | 'invalid_ticket' | 'wrong_event' | 'cancelled';
  notes?: string;

  // Timestamps
  scannedAt: Date;
  createdAt: Date;
}
