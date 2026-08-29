import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IReseller } from '@interfaces/reseller.interface';
import { applyOperatorEventScope } from '@models/operatorEventScope.schema';

const resellerSchema = new Schema<IReseller>({
  businessName: { type: String, required: true, trim: true, index: true },
  slug: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  // Owner password for the email+password allocation-portal login. select:false
  // so it never loads (or serializes) unless explicitly requested.
  password: { type: String, select: false },
  commissionPercent: { type: Number, default: null, min: 0, max: 100 },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: {
    transform: function(_doc, ret) {
      const { __v, password, ...rest } = ret;
      return rest;
    }
  },
  toObject: {
    transform: function(_doc, ret) {
      const { __v, password, ...rest } = ret;
      return rest;
    }
  }
});

applyOperatorEventScope(resellerSchema);

resellerSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

resellerSchema.methods.comparePassword = async function(candidate: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

export const Reseller = mongoose.model<IReseller>('Reseller', resellerSchema);
