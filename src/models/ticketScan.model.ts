import mongoose, { Schema } from 'mongoose';
import { ITicketScan } from '@interfaces/ticket.interface';

const ticketScanSchema = new Schema<ITicketScan>({
  // Scan Details
  ticketId: {
    type: Schema.Types.ObjectId,
    ref: 'Ticket',
    required: [true, 'Ticket ID is required'],
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

  // Scanner Info
  scannedBy: {
    type: Schema.Types.ObjectId,
    required: [true, 'Scanner ID is required'],
    refPath: 'scannedByType'
  },
  scannedByType: {
    type: String,
    required: true,
    enum: ['Vendor', 'VendorSubUser']
  },

  // Scan Result
  isValid: {
    type: Boolean,
    required: true,
    index: true
  },
  scanResult: {
    type: String,
    required: true,
    enum: ['success', 'already_scanned', 'invalid_ticket', 'wrong_event', 'cancelled'],
    index: true
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [500, 'Notes cannot exceed 500 characters']
  },

  // Timestamps
  scannedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for reporting and analytics
ticketScanSchema.index({ eventId: 1, scannedAt: -1 });
ticketScanSchema.index({ vendorId: 1, scannedAt: -1 });
ticketScanSchema.index({ ticketId: 1, scannedAt: -1 });
ticketScanSchema.index({ scannedBy: 1, scannedByType: 1 });
ticketScanSchema.index({ scanResult: 1, isValid: 1 });

export const TicketScan = mongoose.model<ITicketScan>('TicketScan', ticketScanSchema);
