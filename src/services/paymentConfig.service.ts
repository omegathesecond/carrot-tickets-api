import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';

const DEFAULTS = {
  cashEnabled: true,
  mtnMomoEnabled: true,
  keshlessWalletEnabled: false, // Keshless decoupled — off for now
  peachCardEnabled: false,
  deltapayEnabled: false, // off until DeltaPay issues live credentials
  yocoEnabled: false, // off until Yoco credentials are bound + verified
  defaultResellerCommissionPercent: 0,
  platformFeePercent: 0,
  // Live launch values (flat E, added on top at online checkout). Overridable in
  // dashboard Settings; an explicit saved value (incl. 0) always wins.
  keshlessServiceFee: 0,
  momoServiceFee: 5,
  cardServiceFee: 10,
  deltapayServiceFee: 5, // wallet rail — priced like MoMo
  yocoServiceFee: 0, // set at launch alongside the toggle
};

type PaymentConfig = typeof DEFAULTS;

/**
 * Overlay a stored config document on the defaults.
 *
 * Uses `??` rather than `||` on purpose: an organizer who deliberately sets a
 * fee to 0 (or a toggle to false) must keep that value, not silently fall back
 * to a non-zero default. DEFAULTS is the single source of truth for the field
 * list, so adding a payment method means touching it and nothing else here.
 */
function withDefaults(doc: Partial<PaymentConfig> | null | undefined): PaymentConfig {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof PaymentConfig)[]) {
    const saved = doc?.[key];
    if (saved !== undefined && saved !== null) {
      (out as Record<string, unknown>)[key] = saved;
    }
  }
  return out;
}

export class PaymentConfigService {
  static async get(): Promise<PaymentConfig> {
    const doc = await PaymentMethodConfig.findOne({ key: 'global' }).lean();
    return withDefaults(doc as Partial<PaymentConfig> | null);
  }

  static async update(patch: Partial<PaymentConfig>): Promise<PaymentConfig> {
    const doc = await PaymentMethodConfig.findOneAndUpdate(
      { key: 'global' },
      { $set: patch },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return withDefaults(doc as Partial<PaymentConfig> | null);
  }
}
