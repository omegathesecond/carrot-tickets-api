import mongoose, { Schema } from 'mongoose';
import { ITicket, TicketStatus } from '@interfaces/ticket.interface';
import { generateTicketCode } from '@utils/ticketCode.util';

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
  // Snapshot of the event's DISPLAY currency at mint time, so a printed stub /
  // receipt renders the right symbol even if the organizer later changes it.
  currency: {
    type: String,
    enum: ['SZL', 'ZAR'],
    default: 'SZL'
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
  customerEmail: {
    type: String,
    trim: true,
    lowercase: true,
    index: true
  },
  buyerId: {
    type: Schema.Types.ObjectId,
    ref: 'Buyer',
    index: true,
    sparse: true
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
    enum: ['Vendor', 'VendorSubUser', 'GateOperator']
  }
}, {
  timestamps: true
});

// Pre-save hook to generate a short, unambiguous ticketId (generate-and-check).
ticketSchema.pre('save', async function (next) {
  if (this.isNew && !this.ticketId) {
    const model = this.constructor as mongoose.Model<ITicket>;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateTicketCode();
      const exists = await model.exists({ ticketId: candidate });
      if (!exists) { this.ticketId = candidate; return next(); }
    }
    return next(new Error('Could not generate a unique ticket code'));
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
// Activity feed: global newest-first scan of live tickets (the "is going"
// source). Every other Ticket index is a point lookup — none serves recency.
ticketSchema.index({ status: 1, createdAt: -1 });
// Activity feed, Following tab: goingCandidates() filters live tickets by
// `customerPhone: { $in: [...followed actors' phones] }` sorted newest-first
// (see services/activityFeed/going.ts). customerPhone was previously
// unindexed, so the planner fell back to the { status:1, createdAt:-1 }
// index above and scanned-and-discarded every live ticket looking for a
// phone match — a viewer following people with no tickets scanned the whole
// live-ticket collection, on every page. This index serves that query directly.
ticketSchema.index({ customerPhone: 1, status: 1, createdAt: -1 });

export const Ticket = mongoose.model<ITicket>('Ticket', ticketSchema);
