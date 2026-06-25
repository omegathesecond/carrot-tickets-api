import mongoose, { Schema } from 'mongoose';
import { IResellerOperator } from '@interfaces/reseller.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

const operatorSchema = new Schema<IResellerOperator>({
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', required: true },
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true },
  fullName: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  role: {
    type: String,
    required: true,
    enum: ['reseller_admin', 'reseller_hub_manager', 'reseller_operator'],
    index: true,
  },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: {
    transform: function (_doc, ret) {
      const { pin, __v, ...rest } = ret;
      return rest;
    },
  },
  toObject: {
    transform: function (_doc, ret) {
      const { pin, __v, ...rest } = ret;
      return rest;
    },
  },
});

applyOperatorCredentials(operatorSchema);

operatorSchema.index({ resellerId: 1, isActive: 1 });
operatorSchema.index({ hubId: 1, isActive: 1 });

export const ResellerOperator = mongoose.model<IResellerOperator>('ResellerOperator', operatorSchema);
