import mongoose, { Schema } from 'mongoose';
import { ISeat } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const seatSchema = new Schema<ISeat>({
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  seatNumber: { type: String, required: true, trim: true },
  isBooked: { type: Boolean, default: false },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', unique: true, sparse: true },
  isReserved: { type: Boolean, default: false },
  reservedNote: { type: String, trim: true },
  reservedBy: { type: Schema.Types.ObjectId },
  reservedAt: { type: Date },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

seatSchema.index({ tripId: 1, seatNumber: 1 }, { unique: true });
seatSchema.index({ tripId: 1, isBooked: 1 });
seatSchema.index({ tripId: 1, isReserved: 1 });

export const Seat = mongoose.model<ISeat>('Seat', seatSchema);
