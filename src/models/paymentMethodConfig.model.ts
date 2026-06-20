import mongoose, { Schema } from 'mongoose';

export interface IPaymentMethodConfig extends mongoose.Document {
  key: 'global';
  keshlessWalletEnabled: boolean;
  mtnMomoEnabled: boolean;
  updatedAt: Date;
}

const schema = new Schema<IPaymentMethodConfig>({
  key: { type: String, default: 'global', unique: true, index: true },
  keshlessWalletEnabled: { type: Boolean, default: true },
  mtnMomoEnabled: { type: Boolean, default: true },
}, { timestamps: true });

export const PaymentMethodConfig = mongoose.model<IPaymentMethodConfig>('PaymentMethodConfig', schema);
