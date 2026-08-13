import Joi from 'joi';
import { MAX_CHARGE_CENTS } from '@services/merchant.service';

const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{8,}$/);

export const MAX_LINES = 50;
export const MAX_QTY_PER_LINE = 1000;

/**
 * POST /api/merchant/charge — tap-to-pay debit. Exactly one of `amount`
 * (amount-only, un-itemised) or `items` (itemised, server-priced from the
 * catalogue) must be present. merchantId/eventId come from the JWT.
 */
export const chargeSchema = Joi.object({
  bandUid: uid.required(),
  clientTxnId: Joi.string().trim().required(),
  staffName: Joi.string().trim().max(80).optional(),
  amount: Joi.number().integer().min(1).max(MAX_CHARGE_CENTS),
  items: Joi.array()
    .items(Joi.object({
      productId: Joi.string().trim().required(),
      qty: Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required(),
    }))
    .min(1).max(MAX_LINES),
}).xor('amount', 'items');
