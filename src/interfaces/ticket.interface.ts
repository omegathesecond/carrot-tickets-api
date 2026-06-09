import { Document, Types } from 'mongoose';

export enum TicketStatus {
  AVAILABLE = 'available',
  SOLD = 'sold',
  CHECKED_IN = 'checked_in',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled'
}

export enum TicketPdfStatus {
  PENDING = 'pending',
  GENERATING = 'generating',
  READY = 'ready',
  FAILED = 'failed'
}

export enum PaymentMethod {
  CASH = 'cash',
  KESHLESS_WALLET = 'keshless_wallet'
}

export enum PaymentStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded'
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

  // Shareable PDF (generated on demand, cached in R2). Lets the user-app and
  // the keshless-tickets web/dashboard share the SAME ticket PDF.
  pdfUrl?: string;
  pdfStatus?: TicketPdfStatus;
  pdfRequestedAt?: Date; // when generation last started — used to recover from a stalled 'generating'

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

  // Staff
  soldBy: Types.ObjectId; // Staff member who made the sale
  soldByType: 'Vendor' | 'VendorSubUser'; // Who sold it

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
  scannedByType: 'vendor' | 'sub_user';

  // Scan Result
  isValid: boolean;
  scanResult: 'success' | 'already_scanned' | 'invalid_ticket' | 'wrong_event' | 'cancelled';
  notes?: string;

  // Timestamps
  scannedAt: Date;
  createdAt: Date;
}
