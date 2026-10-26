import Joi from 'joi';

export interface PurchaseCharge { type: 'fixed' | 'percentage'; value: number }

/** Fixed values are integer cents; percentage values have at most two decimals. Null disables the charge. */
export const purchaseChargeSchema = Joi.object({
  type: Joi.string().valid('fixed', 'percentage').required(),
  value: Joi.when('type', {
    is: 'fixed', then: Joi.number().integer().min(1).max(10_000_000).required(),
    otherwise: Joi.number().greater(0).max(100).precision(2).strict().required(),
  }),
}).allow(null);

export function purchaseChargeAmount(subtotal: number, setting: PurchaseCharge | null | undefined): number {
  if (!Number.isSafeInteger(subtotal) || subtotal <= 0) throw new Error('purchase subtotal must be positive integer cents');
  if (setting == null) return 0;
  const { error } = purchaseChargeSchema.validate(setting, { convert: false });
  if (error) throw new Error(`Invalid purchase charge setting: ${error.message}`);
  // Calculate in basis points so decimal percentages do not produce floating point cent errors.
  const amount = setting.type === 'fixed' ? setting.value : Number((BigInt(subtotal) * BigInt(Math.round(setting.value * 100)) + BigInt(5000)) / BigInt(10000));
  if (!Number.isSafeInteger(subtotal + amount)) throw new Error('Purchase total exceeds safe integer cents');
  return amount;
}

export class PurchaseTotalChangedError extends Error {
  constructor() { super('Purchase total changed — review the charge and try again'); }
}
