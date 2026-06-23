import mongoose, { Schema } from 'mongoose';

export interface IPaymentMethodConfig extends mongoose.Document {
  key: 'global';
  cashEnabled: boolean;
  keshlessWalletEnabled: boolean;
  mtnMomoEnabled: boolean;
  defaultResellerCommissionPercent: number;
  platformFeePercent: number;
  updatedAt: Date;
}

const schema = new Schema<IPaymentMethodConfig>({
  key: { type: String, default: 'global', unique: true, index: true },
  cashEnabled: { type: Boolean, default: true },
  keshlessWalletEnabled: { type: Boolean, default: false },
  mtnMomoEnabled: { type: Boolean, default: true },
  defaultResellerCommissionPercent: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
}, { timestamps: true });

export const PaymentMethodConfig = mongoose.model<IPaymentMethodConfig>('PaymentMethodConfig', schema);
