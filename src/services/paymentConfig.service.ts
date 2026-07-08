import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';

const DEFAULTS = {
  cashEnabled: true,
  mtnMomoEnabled: true,
  keshlessWalletEnabled: false, // Keshless decoupled — off for now
  peachCardEnabled: false,
  defaultResellerCommissionPercent: 0,
  platformFeePercent: 0,
  // Live launch values (flat E, added on top at online checkout). Overridable in
  // dashboard Settings; an explicit saved value (incl. 0) always wins.
  keshlessServiceFee: 0,
  momoServiceFee: 5,
  cardServiceFee: 10,
};

type PaymentConfig = typeof DEFAULTS;

export class PaymentConfigService {
  static async get(): Promise<PaymentConfig> {
    const doc = await PaymentMethodConfig.findOne({ key: 'global' }).lean();
    return {
      cashEnabled: doc?.cashEnabled ?? DEFAULTS.cashEnabled,
      mtnMomoEnabled: doc?.mtnMomoEnabled ?? DEFAULTS.mtnMomoEnabled,
      keshlessWalletEnabled: doc?.keshlessWalletEnabled ?? DEFAULTS.keshlessWalletEnabled,
      peachCardEnabled: doc?.peachCardEnabled ?? DEFAULTS.peachCardEnabled,
      defaultResellerCommissionPercent: doc?.defaultResellerCommissionPercent ?? DEFAULTS.defaultResellerCommissionPercent,
      platformFeePercent: doc?.platformFeePercent ?? DEFAULTS.platformFeePercent,
      keshlessServiceFee: doc?.keshlessServiceFee ?? DEFAULTS.keshlessServiceFee,
      momoServiceFee: doc?.momoServiceFee ?? DEFAULTS.momoServiceFee,
      cardServiceFee: doc?.cardServiceFee ?? DEFAULTS.cardServiceFee,
    };
  }

  static async update(patch: Partial<PaymentConfig>): Promise<PaymentConfig> {
    const doc = await PaymentMethodConfig.findOneAndUpdate(
      { key: 'global' },
      { $set: patch },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return {
      cashEnabled: doc!.cashEnabled ?? DEFAULTS.cashEnabled,
      mtnMomoEnabled: doc!.mtnMomoEnabled ?? DEFAULTS.mtnMomoEnabled,
      keshlessWalletEnabled: doc!.keshlessWalletEnabled ?? DEFAULTS.keshlessWalletEnabled,
      peachCardEnabled: doc!.peachCardEnabled ?? DEFAULTS.peachCardEnabled,
      defaultResellerCommissionPercent: doc!.defaultResellerCommissionPercent ?? DEFAULTS.defaultResellerCommissionPercent,
      platformFeePercent: doc!.platformFeePercent ?? DEFAULTS.platformFeePercent,
      keshlessServiceFee: doc!.keshlessServiceFee ?? DEFAULTS.keshlessServiceFee,
      momoServiceFee: doc!.momoServiceFee ?? DEFAULTS.momoServiceFee,
      cardServiceFee: doc!.cardServiceFee ?? DEFAULTS.cardServiceFee,
    };
  }
}
