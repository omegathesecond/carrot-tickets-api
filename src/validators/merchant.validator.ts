import Joi from 'joi';
import { MAX_CHARGE_CENTS } from '@services/merchant.service';

const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{8,}$/);

/**
 * POST /api/merchant/charge — tap-to-pay debit of an attendee's wallet by
 * band uid (cashless spec). merchantId/eventId come from the verified
 * merchant JWT, never the body. Amount is integer minor units (cents),
 * capped at MAX_CHARGE_CENTS as a safety ceiling against ledger inflation —
 * mirrors cashTopupSchema. clientTxnId makes the charge idempotent
 * (MerchantService.charge).
 */
export const chargeSchema = Joi.object({
  bandUid: uid.required(),
  amount: Joi.number().integer().min(1).max(MAX_CHARGE_CENTS).required(),
  clientTxnId: Joi.string().trim().required(),
});
