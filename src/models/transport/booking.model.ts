import mongoose, { Schema } from 'mongoose';
import { IBooking, BookingStatus } from '@interfaces/booking.interface';
import { generateTicketCode } from '@utils/ticketCode.util';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const bookingSchema = new Schema<IBooking>({
  bookingRef: { type: String, unique: true, index: true },
  qrCode: { type: String, unique: true, index: true },
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  passengerName: { type: String, required: true, trim: true },
  passengerPhone: { type: String, required: true, trim: true },
  seatNumber: { type: String, trim: true },
  fareAmount: { type: Number, required: true, min: 0 },
  platformFee: { type: Number, required: true, min: 0, default: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  saleId: { type: Schema.Types.ObjectId, ref: 'BookingSale', index: true },
  purchasedBy: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
  status: { type: String, enum: Object.values(BookingStatus), default: BookingStatus.PENDING, index: true },
  boardedAt: { type: Date },
  boardedBy: { type: Schema.Types.ObjectId },
  cancelledAt: { type: Date },
  refundedAt: { type: Date },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

// Generate-and-check unique short codes for bookingRef + qrCode (mirror Ticket).
bookingSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const model = this.constructor as mongoose.Model<IBooking>;
  const uniqueCode = async (field: 'bookingRef' | 'qrCode'): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateTicketCode();
      const exists = await model.exists({ [field]: candidate });
      if (!exists) return candidate;
    }
    throw new Error(`Could not generate a unique booking ${field}`);
  };
  try {
    if (!this.bookingRef) this.bookingRef = await uniqueCode('bookingRef');
    if (!this.qrCode) {
      let qr = await uniqueCode('qrCode');
      while (qr === this.bookingRef) qr = await uniqueCode('qrCode');
      this.qrCode = qr;
    }
    next();
  } catch (err) { next(err as Error); }
});

bookingSchema.index({ tripId: 1, status: 1 });
bookingSchema.index({ vendorId: 1, createdAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });

export const Booking = mongoose.model<IBooking>('Booking', bookingSchema);
