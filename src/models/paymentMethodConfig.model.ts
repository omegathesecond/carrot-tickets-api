import mongoose, { Schema } from 'mongoose';

export interface IPaymentMethodConfig extends mongoose.Document {
  key: 'global';
  cashEnabled: boolean;
  keshlessWalletEnabled: boolean;
  mtnMomoEnabled: boolean;
  cardEnabled: boolean;
  defaultResellerCommissionPercent: number;
  platformFeePercent: number;
  // Buyer-paid FLAT service fee (in E) per ONLINE method — added on top of the
  // ticket price at checkout (distinct from platformFeePercent, a payout %).
  keshlessServiceFee: number;
  momoServiceFee: number;
  cardServiceFee: number;
  updatedAt: Date;
}

const schema = new Schema<IPaymentMethodConfig>({
  key: { type: String, default: 'global', unique: true, index: true },
  cashEnabled: { type: Boolean, default: true },
  keshlessWalletEnabled: { type: Boolean, default: false },
  mtnMomoEnabled: { type: Boolean, default: true },
  cardEnabled: { type: Boolean, default: false },
  defaultResellerCommissionPercent: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
  keshlessServiceFee: { type: Number, default: 0 },
  momoServiceFee: { type: Number, default: 0 },
  cardServiceFee: { type: Number, default: 0 },
}, { timestamps: true });

export const PaymentMethodConfig = mongoose.model<IPaymentMethodConfig>('PaymentMethodConfig', schema);
