import { Document } from 'mongoose';
import Joi from 'joi';

export interface FeeTier { min: number; max: number | null; fee: number }
export type PurchaseCharge = { type: 'fixed' | 'percentage'; value: number } | { type: 'tiered'; tiers: FeeTier[] };

/** Amounts are integer cents. Ranges include min and exclude max; null means no upper limit. */
export const purchaseChargeSchema = Joi.alternatives().try(
  Joi.object({
    type: Joi.string().valid('fixed', 'percentage').required(),
    value: Joi.when('type', {
      is: 'fixed', then: Joi.number().integer().min(1).max(10_000_000).required(),
      otherwise: Joi.number().greater(0).max(100).precision(2).strict().required(),
    }),
  }),
  Joi.object({
    type: Joi.string().valid('tiered').required(),
    tiers: Joi.array().min(1).max(50).items(Joi.object({
      min: Joi.number().integer().min(0).max(10_000_000).required(),
      max: Joi.number().integer().greater(Joi.ref('min')).max(10_000_000).allow(null).required(),
      fee: Joi.number().integer().min(0).max(10_000_000).required(),
    })).custom((tiers: FeeTier[], helpers) => {
      if (tiers[0]!.min !== 0 || tiers[tiers.length - 1]!.max !== null ||
        tiers.some((tier, i) => i < tiers.length - 1 && (tier.max === null || tier.max !== tiers[i + 1]!.min))) {
        return helpers.message({ custom: 'Tiers must start at zero, meet without gaps or overlaps, and end with no upper limit' });
      }
      return tiers;
    }).required(),
  }),
).allow(null);

export function purchaseChargeAmount(subtotal: number, setting: PurchaseCharge | null | undefined): number {
  if (!Number.isSafeInteger(subtotal) || subtotal <= 0) throw new Error('purchase subtotal must be positive integer cents');
  if (setting == null) return 0;
  if (setting instanceof Document) setting = setting.toObject<PurchaseCharge>();
  const { error } = purchaseChargeSchema.validate(setting, { convert: false });
  if (error) throw new Error(`Invalid cashless fee setting: ${error.message}`);
  let amount: number;
  if (setting.type === 'tiered') {
    const tier = setting.tiers.find(t => subtotal >= t.min && (t.max === null || subtotal < t.max));
    if (!tier) throw new Error('No fee tier covers this amount');
    amount = tier.fee;
  } else {
    amount = setting.type === 'fixed' ? setting.value : Number((BigInt(subtotal) * BigInt(Math.round(setting.value * 100)) + BigInt(5000)) / BigInt(10000));
  }
  if (!Number.isSafeInteger(subtotal + amount)) throw new Error('Purchase total exceeds safe integer cents');
  return amount;
}

export function withdrawalQuote(amount: number, setting: PurchaseCharge | null | undefined) {
  const feeAmount = purchaseChargeAmount(amount, setting);
  return { amount, feeAmount, payoutAmount: amount - feeAmount };
}

export class PurchaseTotalChangedError extends Error {
  constructor() { super('Purchase total changed — review the charge and try again'); }
}
