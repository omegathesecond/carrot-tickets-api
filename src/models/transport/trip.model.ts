import mongoose, { Schema } from 'mongoose';
import { ITrip, TripStatus, SeatScheme } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const tripSchema = new Schema<ITrip>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  routeId: { type: Schema.Types.ObjectId, ref: 'Route', required: true, index: true },
  vehicleTypeId: { type: Schema.Types.ObjectId, ref: 'VehicleType', required: true },
  departureTime: { type: Date, required: [true, 'Departure time is required'] },
  arrivalTime: { type: Date },
  vehicleReg: { type: String, trim: true },
  totalSeats: { type: Number, required: true, min: [1, 'A trip must have at least 1 seat'] },
  seatScheme: { type: String, enum: Object.values(SeatScheme), required: true },
  soldCount: { type: Number, default: 0, min: 0 },
  reservedCount: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: Object.values(TripStatus), default: TripStatus.SCHEDULED, index: true },
  reminderSentAt: { type: Date },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

tripSchema.index({ routeId: 1, departureTime: 1 });
tripSchema.index({ vendorId: 1, departureTime: 1 });
tripSchema.index({ status: 1, departureTime: 1 });

export const Trip = mongoose.model<ITrip>('Trip', tripSchema);
