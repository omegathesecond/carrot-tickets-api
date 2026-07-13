import mongoose, { Schema } from 'mongoose';
import { IRoute } from '@interfaces/transport.interface';

const stripV = { transform: (_doc: any, ret: any) => { const { __v, ...rest } = ret; return rest; } };

const routeSchema = new Schema<IRoute>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  name: { type: String, required: [true, 'Route name is required'], trim: true },
  originCity: { type: String, required: [true, 'Origin city is required'], trim: true },
  destinationCity: { type: String, required: [true, 'Destination city is required'], trim: true },
  stops: { type: [String], get: (val: any) => val && val.length > 0 ? val : undefined },
  farePerSeat: { type: Number, required: [true, 'Fare per seat is required'], min: [0, 'Fare cannot be negative'] },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, toJSON: stripV, toObject: stripV });

routeSchema.index({ vendorId: 1, isActive: 1 });
routeSchema.index({ originCity: 1, destinationCity: 1 });

export const Route = mongoose.model<IRoute>('Route', routeSchema);
