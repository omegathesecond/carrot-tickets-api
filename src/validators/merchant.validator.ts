import Joi from 'joi';
import { MAX_CHARGE_CENTS } from '@services/merchant.service';
import { objectId } from '@validators/stock.validator';

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
  // Accepted-but-discarded: attribution now comes ONLY from the verified
  // MerchantToken (merchantOperatorId + operatorName), never the body.
  // Joi.any().strip() removes the key at the validation edge (rather than
  // just accepting-and-ignoring it downstream) so "never read" is structural,
  // not conventional — no future code path can accidentally consume it. Also
  // strictly more backward-compatible than Joi.string(): Joi rejects empty
  // strings by default, so a stale POS sending `staffName: ''` would still
  // get a 400 on a field the server discards; .any().strip() accepts and
  // drops anything.
  staffName: Joi.any().strip(),
  amount: Joi.number().integer().min(1).max(MAX_CHARGE_CENTS),
  items: Joi.array()
    .items(Joi.object({
      productId: objectId.required(),
      qty: Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required(),
    }))
    .min(1).max(MAX_LINES),
}).xor('amount', 'items');
