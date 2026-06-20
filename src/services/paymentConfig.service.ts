import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';

const DEFAULTS = { keshlessWalletEnabled: true, mtnMomoEnabled: true };

export class PaymentConfigService {
  static async get(): Promise<{ keshlessWalletEnabled: boolean; mtnMomoEnabled: boolean }> {
    const doc = await PaymentMethodConfig.findOne({ key: 'global' }).lean();
    return {
      keshlessWalletEnabled: doc?.keshlessWalletEnabled ?? DEFAULTS.keshlessWalletEnabled,
      mtnMomoEnabled: doc?.mtnMomoEnabled ?? DEFAULTS.mtnMomoEnabled,
    };
  }

  static async update(patch: Partial<{ keshlessWalletEnabled: boolean; mtnMomoEnabled: boolean }>) {
    const doc = await PaymentMethodConfig.findOneAndUpdate(
      { key: 'global' },
      { $set: patch },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return {
      keshlessWalletEnabled: doc!.keshlessWalletEnabled,
      mtnMomoEnabled: doc!.mtnMomoEnabled,
    };
  }
}
