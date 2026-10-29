import { omit } from '@utils/omit.util';
// api/src/models/gateOperator.model.ts
import mongoose, { Schema } from 'mongoose';
import { IGateOperator } from '@interfaces/gateOperator.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';
import { applyOperatorEventScope } from '@models/operatorEventScope.schema';

const gateOperatorSchema = new Schema<IGateOperator>({
  deletedAt: { type: Date },
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  scope: { type: String, required: true, enum: ['platform', 'organizer'], index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const rest = omit(ret, ['pin', '__v']); return rest; } },
  toObject: { transform: (_doc, ret) => { const rest = omit(ret, ['pin', '__v']); return rest; } },
});

applyOperatorCredentials(gateOperatorSchema, true);
applyOperatorEventScope(gateOperatorSchema);

gateOperatorSchema.index({ vendorId: 1, isActive: 1 });

export const GateOperator = mongoose.model<IGateOperator>('GateOperator', gateOperatorSchema);
