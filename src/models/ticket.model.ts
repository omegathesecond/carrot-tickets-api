import mongoose, { Schema } from 'mongoose';
import { ITicket, TicketStatus, TicketPdfStatus } from '@interfaces/ticket.interface';

const ticketSchema = new Schema<ITicket>({
  // Ticket Identification
  ticketId: {
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

  // Ticket Details
  ticketType: {
    type: String,
    required: [true, 'Ticket type is required'],
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },

  // Ownership
  purchasedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Keshless user if purchased via app
    sparse: true
  },
  customerName: {
    type: String,
    trim: true,
    maxlength: [100, 'Customer name cannot exceed 100 characters']
  },
  customerPhone: {
    type: String,
    trim: true
  },
  saleId: {
    type: Schema.Types.ObjectId,
    ref: 'TicketSale',
    index: true
  },

  // Status
  status: {
    type: String,
    enum: Object.values(TicketStatus),
    default: TicketStatus.AVAILABLE,
    index: true
  },

  // Entry Tracking
  checkedInAt: {
    type: Date
  },
  checkedInBy: {
    type: Schema.Types.ObjectId,
    refPath: 'checkedInByModel'
  },
  checkedInByModel: {
    type: String,
    enum: ['Vendor', 'VendorSubUser']
  },

  // Shareable PDF (lazily generated, cached in R2)
  pdfUrl: {
    type: String,
    trim: true
  },
  pdfStatus: {
    type: String,
    enum: Object.values(TicketPdfStatus)
  },
  pdfRequestedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Pre-save hook to generate ticketId
ticketSchema.pre('save', function(next) {
  if (this.isNew && !this.ticketId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.ticketId = `TKT-${timestamp}-${random}`;
  }
  next();
});

// Method to mark ticket as checked in
ticketSchema.methods.checkIn = function(scannerId: string, scannerModel: string) {
  this.status = TicketStatus.CHECKED_IN;
  this.checkedInAt = new Date();
  this.checkedInBy = scannerId;
  this.checkedInByModel = scannerModel;
  return this.save();
};

// Method to check if ticket is valid for entry
ticketSchema.methods.isValidForEntry = function(): boolean {
  return this.status === TicketStatus.SOLD;
};

// Indexes
ticketSchema.index({ eventId: 1, status: 1 });
ticketSchema.index({ vendorId: 1, status: 1 });
ticketSchema.index({ saleId: 1 });
ticketSchema.index({ purchasedBy: 1 });
ticketSchema.index({ ticketId: 1 }, { unique: true });

export const Ticket = mongoose.model<ITicket>('Ticket', ticketSchema);
