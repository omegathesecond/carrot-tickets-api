import mongoose, { Schema } from 'mongoose';
import { IEvent, EventStatus, ITicketType } from '@interfaces/event.interface';

const ticketTypeSchema = new Schema<ITicketType>({
  name: {
    type: String,
    required: [true, 'Ticket type name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },
  sold: {
    type: Number,
    default: 0,
    min: 0
  },
  available: {
    type: Number,
    default: function(this: ITicketType) {
      return this.quantity - this.sold;
    }
  },
  reserved:    { type: Number, default: 0, min: 0 },
  isSoldOut: {
    type: Boolean,
    default: false
  }
}, { _id: true });

const eventSchema = new Schema<IEvent>({
  // Event Identification
  eventId: {
    type: String,
    unique: true,
    index: true
  },
  vendorId: {
    type: Schema.Types.ObjectId,
    ref: 'Vendor',
    required: [true, 'Vendor ID is required'],
    index: true
  },

  // Event Details
  name: {
    type: String,
    required: [true, 'Event name is required'],
    trim: true,
    maxlength: [200, 'Event name cannot exceed 200 characters'],
    index: true
  },
  description: {
    type: String,
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  venue: {
    type: String,
    required: [true, 'Venue is required'],
    trim: true,
    maxlength: [200, 'Venue cannot exceed 200 characters']
  },
  eventDate: {
    type: Date,
    required: [true, 'Event date is required'],
    index: true
  },
  startTime: {
    type: Date,
    required: [true, 'Start time is required']
  },
  endTime: {
    type: Date,
    required: [true, 'End time is required']
  },
  isMultiDay: {
    type: Boolean,
    default: false
  },

  // Capacity & Tickets
  // Capacity is no longer collected at event creation — it is derived from
  // the sum of ticket-type quantities in the pre-save hook below, so the
  // "tickets sold / capacity" figure always matches the tickets that actually
  // exist (previously an organiser could set capacity 500 yet add 1000
  // tickets, producing a misleading 0/500).
  capacity: {
    type: Number,
    default: 0,
    min: [0, 'Capacity cannot be negative']
  },
  ticketTypes: {
    type: [ticketTypeSchema],
    default: []
  },

  // Status
  status: {
    type: String,
    enum: Object.values(EventStatus),
    default: EventStatus.DRAFT,
    index: true
  },

  // Sales Info
  totalTicketsSold: {
    type: Number,
    default: 0,
    min: 0
  },
  totalRevenue: {
    type: Number,
    default: 0,
    min: 0
  },

  // Media & Images
  posterUrl: {
    type: String,
    trim: true
  },
  thumbnailUrl: {
    type: String,
    trim: true
  },
  galleryImages: {
    type: [String],
    default: []
  },
  qrCodeUrl: {
    type: String,
    trim: true
  },

  // Publishing
  publishedAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  cancellationReason: {
    type: String,
    maxlength: 500
  }
}, {
  timestamps: true
});

// Pre-save hook to generate eventId
eventSchema.pre('save', function(next) {
  if (this.isNew && !this.eventId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.eventId = `EVT-${timestamp}-${random}`;
  }
  next();
});

// Pre-save hook to update ticket availability and total sold
eventSchema.pre('save', function(next) {
  if (this.ticketTypes && this.ticketTypes.length > 0) {
    // Update available count for each ticket type
    this.ticketTypes.forEach(ticketType => {
      ticketType.available = Math.max(0, ticketType.quantity - ticketType.sold - (ticketType.reserved || 0));
    });

    // Calculate total tickets sold across all ticket types
    this.totalTicketsSold = this.ticketTypes.reduce((sum, ticketType) => {
      return sum + ticketType.sold;
    }, 0);

    // Derive capacity from the total tickets created across all types so the
    // "sold / capacity" figure can never contradict the tickets that exist.
    this.capacity = this.ticketTypes.reduce((sum, ticketType) => {
      return sum + ticketType.quantity;
    }, 0);
  }
  next();
});

// Method to get total tickets available across all types
eventSchema.methods.getTotalAvailable = function(this: IEvent): number {
  return this.ticketTypes.reduce((sum: number, type: ITicketType) => sum + type.available, 0);
};

// Method to check if event is sold out
eventSchema.methods.isSoldOut = function(this: IEvent): boolean {
  return (this as any).getTotalAvailable() === 0;
};

// Indexes
eventSchema.index({ vendorId: 1, status: 1 });
eventSchema.index({ eventDate: 1, status: 1 });
eventSchema.index({ vendorId: 1, eventDate: -1 });

export const Event = mongoose.model<IEvent>('Event', eventSchema);
