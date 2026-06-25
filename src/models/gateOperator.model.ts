// api/src/models/gateOperator.model.ts
import mongoose, { Schema } from 'mongoose';
import { IGateOperator } from '@interfaces/gateOperator.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

const gateOperatorSchema = new Schema<IGateOperator>({
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  scope: { type: String, required: true, enum: ['platform', 'organizer'], index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(gateOperatorSchema);

gateOperatorSchema.index({ vendorId: 1, isActive: 1 });

export const GateOperator = mongoose.model<IGateOperator>('GateOperator', gateOperatorSchema);
