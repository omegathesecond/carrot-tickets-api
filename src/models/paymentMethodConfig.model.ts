import mongoose, { Schema } from 'mongoose';

export interface IPaymentMethodConfig extends mongoose.Document {
  key: 'global';
  cashEnabled: boolean;
  keshlessWalletEnabled: boolean;
  mtnMomoEnabled: boolean;
  peachCardEnabled: boolean;
  deltapayEnabled: boolean;
  yocoEnabled: boolean;
  defaultResellerCommissionPercent: number;
  platformFeePercent: number;
  // Buyer-paid FLAT service fee (in E) per ONLINE method — added on top of the
  // ticket price at checkout (distinct from platformFeePercent, a payout %).
  keshlessServiceFee: number;
  momoServiceFee: number;
  cardServiceFee: number;
  deltapayServiceFee: number;
  yocoServiceFee: number;
  // Buyer-paid PERCENTAGE service charge on Menu (bar/vendor preorder) cart
  // subtotals — the fee for ordering ahead through Carrot instead of queueing.
  // Distinct from the flat per-ticket *ServiceFee fields above.
  menuServiceFeePercent: number;
  updatedAt: Date;
}

const schema = new Schema<IPaymentMethodConfig>({
  key: { type: String, default: 'global', unique: true, index: true },
  cashEnabled: { type: Boolean, default: true },
  keshlessWalletEnabled: { type: Boolean, default: false },
  mtnMomoEnabled: { type: Boolean, default: true },
  peachCardEnabled: { type: Boolean, default: false },
  deltapayEnabled: { type: Boolean, default: false },
  yocoEnabled: { type: Boolean, default: false },
  defaultResellerCommissionPercent: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
  keshlessServiceFee: { type: Number, default: 0 },
  momoServiceFee: { type: Number, default: 0 },
  cardServiceFee: { type: Number, default: 0 },
  deltapayServiceFee: { type: Number, default: 0 },
  yocoServiceFee: { type: Number, default: 0 },
  menuServiceFeePercent: { type: Number, default: 8 },
}, { timestamps: true });

export const PaymentMethodConfig = mongoose.model<IPaymentMethodConfig>('PaymentMethodConfig', schema);
