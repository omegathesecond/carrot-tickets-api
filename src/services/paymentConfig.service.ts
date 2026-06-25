import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';

const DEFAULTS = {
  cashEnabled: true,
  mtnMomoEnabled: true,
  keshlessWalletEnabled: false, // Keshless decoupled — off for now
  cardEnabled: false,
  defaultResellerCommissionPercent: 0,
  platformFeePercent: 0,
};

type PaymentConfig = typeof DEFAULTS;

export class PaymentConfigService {
  static async get(): Promise<PaymentConfig> {
    const doc = await PaymentMethodConfig.findOne({ key: 'global' }).lean();
    return {
      cashEnabled: doc?.cashEnabled ?? DEFAULTS.cashEnabled,
      mtnMomoEnabled: doc?.mtnMomoEnabled ?? DEFAULTS.mtnMomoEnabled,
      keshlessWalletEnabled: doc?.keshlessWalletEnabled ?? DEFAULTS.keshlessWalletEnabled,
      cardEnabled: doc?.cardEnabled ?? DEFAULTS.cardEnabled,
      defaultResellerCommissionPercent: doc?.defaultResellerCommissionPercent ?? DEFAULTS.defaultResellerCommissionPercent,
      platformFeePercent: doc?.platformFeePercent ?? DEFAULTS.platformFeePercent,
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
      cardEnabled: doc!.cardEnabled ?? DEFAULTS.cardEnabled,
      defaultResellerCommissionPercent: doc!.defaultResellerCommissionPercent ?? DEFAULTS.defaultResellerCommissionPercent,
      platformFeePercent: doc!.platformFeePercent ?? DEFAULTS.platformFeePercent,
    };
  }
}
