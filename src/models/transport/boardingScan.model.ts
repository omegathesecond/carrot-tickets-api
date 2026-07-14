import mongoose, { Schema } from 'mongoose';
import { IBoardingScan, BoardingScanResult } from '@interfaces/booking.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const boardingScanSchema = new Schema<IBoardingScan>({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  scannedBy: { type: Schema.Types.ObjectId, required: true, refPath: 'scannedByType' },
  scannedByType: { type: String, required: true, enum: ['Vendor', 'VendorSubUser', 'ResellerOperator'] },
  result: { type: String, enum: Object.values(BoardingScanResult), required: true, index: true },
  notes: { type: String, trim: true, maxlength: 500 },
  scannedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

boardingScanSchema.index({ tripId: 1, scannedAt: -1 });
boardingScanSchema.index({ bookingId: 1, scannedAt: -1 });
boardingScanSchema.index({ scannedBy: 1, scannedAt: -1 });

export const BoardingScan = mongoose.model<IBoardingScan>('BoardingScan', boardingScanSchema);
