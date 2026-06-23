import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { IResellerOperator } from '@interfaces/reseller.interface';

const operatorSchema = new Schema<IResellerOperator>({
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', required: true },
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', required: true },
  fullName: { type: String, required: true, trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    select: false
  },
  role: {
    type: String,
    required: true,
    enum: ['reseller_admin', 'reseller_hub_manager', 'reseller_operator'],
    index: true
  },
  isActive: { type: Boolean, default: true, index: true },
  mustChangePassword: { type: Boolean, default: true },
  firstLogin: { type: Boolean, default: true },
  lastLoginAt: { type: Date },
}, {
  timestamps: true,
  toJSON: {
    transform: function(_doc, ret) {
      const { password, __v, ...rest } = ret;
      return rest;
    }
  },
  toObject: {
    transform: function(_doc, ret) {
      const { password, __v, ...rest } = ret;
      return rest;
    }
  }
});

operatorSchema.pre('save', async function(next) {
  try {
    if (this.isModified('password')) {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
    }
    next();
  } catch (error) {
    next(error as Error);
  }
});

operatorSchema.methods.comparePassword = function(this: IResellerOperator, candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, (this as any).password);
};

operatorSchema.index({ resellerId: 1, isActive: 1 });
operatorSchema.index({ hubId: 1, isActive: 1 });

export const ResellerOperator = mongoose.model<IResellerOperator>('ResellerOperator', operatorSchema);
