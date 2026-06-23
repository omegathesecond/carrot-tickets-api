import mongoose, { Schema } from 'mongoose';
import { IReseller } from '@interfaces/reseller.interface';

const resellerSchema = new Schema<IReseller>({
  businessName: { type: String, required: true, trim: true, index: true },
  slug: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  commissionPercent: { type: Number, default: null, min: 0, max: 100 },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: {
    transform: function(_doc, ret) {
      const { __v, ...rest } = ret;
      return rest;
    }
  },
  toObject: {
    transform: function(_doc, ret) {
      const { __v, ...rest } = ret;
      return rest;
    }
  }
});

export const Reseller = mongoose.model<IReseller>('Reseller', resellerSchema);
