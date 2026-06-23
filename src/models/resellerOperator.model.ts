import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IResellerOperator } from '@interfaces/reseller.interface';

const operatorSchema = new Schema<IResellerOperator>({
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', required: true },
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true },
  fullName: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  pin: {
    type: String,
    required: [true, 'PIN is required'],
    select: false,
  },
  role: {
    type: String,
    required: true,
    enum: ['reseller_admin', 'reseller_hub_manager', 'reseller_operator'],
    index: true,
  },
  isActive: { type: Boolean, default: true, index: true },
  failedPinAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastLoginAt: { type: Date },
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

operatorSchema.pre('save', async function (next) {
  try {
    if (this.isModified('pin')) {
      const salt = await bcrypt.genSalt(12);
      this.pin = await bcrypt.hash(this.pin, salt);
    }
    next();
  } catch (error) {
    next(error as Error);
  }
});

operatorSchema.methods.comparePin = function (this: IResellerOperator, candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, (this as any).pin);
};

operatorSchema.index({ resellerId: 1, isActive: 1 });
operatorSchema.index({ hubId: 1, isActive: 1 });

export const ResellerOperator = mongoose.model<IResellerOperator>('ResellerOperator', operatorSchema);
