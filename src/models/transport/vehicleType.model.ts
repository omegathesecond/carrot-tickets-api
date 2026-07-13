import mongoose, { Schema } from 'mongoose';
import { IVehicleType, SeatScheme } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const vehicleTypeSchema = new Schema<IVehicleType>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  name: { type: String, required: [true, 'Vehicle type name is required'], trim: true },
  totalSeats: { type: Number, required: [true, 'Total seats is required'], min: [1, 'A vehicle must have at least 1 seat'] },
  seatScheme: { type: String, enum: Object.values(SeatScheme), default: SeatScheme.SEQUENTIAL },
  layoutJson: { type: Schema.Types.Mixed, default: null },
  registrations: { type: [String], default: [] },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

vehicleTypeSchema.index({ vendorId: 1, name: 1 }, { unique: true });
vehicleTypeSchema.index({ vendorId: 1, isActive: 1 });

export const VehicleType = mongoose.model<IVehicleType>('VehicleType', vehicleTypeSchema);
