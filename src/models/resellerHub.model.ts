import mongoose, { Schema } from 'mongoose';
import { IResellerHub } from '@interfaces/reseller.interface';

const hubSchema = new Schema<IResellerHub>({
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true, index: true },
  name: { type: String, required: true, trim: true },
  location: {
    city: { type: String, trim: true },
    region: { type: String, trim: true }
  },
  isActive: { type: Boolean, default: true },
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

hubSchema.index({ resellerId: 1, isActive: 1 });

export const ResellerHub = mongoose.model<IResellerHub>('ResellerHub', hubSchema);
