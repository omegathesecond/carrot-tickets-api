import { omit } from '@utils/omit.util';
import mongoose, { Schema } from 'mongoose';
import { IResellerHub } from '@interfaces/reseller.interface';

const hubSchema = new Schema<IResellerHub>({
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true },
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
      const rest = omit(ret, ['__v']);
      return rest;
    }
  },
  toObject: {
    transform: function(_doc, ret) {
      const rest = omit(ret, ['__v']);
      return rest;
    }
  }
});

hubSchema.index({ resellerId: 1, isActive: 1 });

export const ResellerHub = mongoose.model<IResellerHub>('ResellerHub', hubSchema);
