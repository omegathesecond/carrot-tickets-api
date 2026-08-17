import Joi from 'joi';
import { MAX_TOPUP_CENTS } from '@services/wallet.service';

// The cashier top-up is identical in shape to the reseller desk top-up, so the
// canonical schema is reused directly by the controller (see reseller.validator
// cashTopupSchema) — no duplicate definition.

const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{8,}$/);

/**
 * POST /api/cashier/withdraw — cash-out of an already-bound band's wallet. The
 * band must exist (you can only hand back money that's on a wallet), so bandUid
 * is required. Amount is integer minor units (cents), capped by the same
 * ceiling as top-up; clientTxnId makes the cash-out idempotent.
 */
export const cashierWithdrawSchema = Joi.object({
  bandUid: uid.required(),
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required(),
  amount: Joi.number().integer().min(1).max(MAX_TOPUP_CENTS).required(),
  clientTxnId: Joi.string().trim().required(),
});
