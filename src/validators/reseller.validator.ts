import Joi from 'joi';

const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{14,}$/);

/**
 * POST /api/reseller/wallets/cash-topup — either an already-bound band OR a
 * ticketId, never both (spec §5.2). Amount is integer minor units (cents);
 * clientTxnId makes the top-up idempotent (WalletService.topUpCash).
 */
export const cashTopupSchema = Joi.object({
  ticketId: Joi.string().trim(),
  bandUid: uid,
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required(),
  amount: Joi.number().integer().min(1).required(),
  clientTxnId: Joi.string().trim().required(),
}).xor('ticketId', 'bandUid');

/**
 * POST /api/reseller/wallets/sell-band — Task 7 (band sale at the door):
 * mints the wallet, binds the band, and optionally cash-tops-up in one call.
 */
export const sellBandSchema = Joi.object({
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required(),
  ticketTypeId: Joi.string().required(),
  bandUid: uid.required(),
  cashAmount: Joi.number().integer().min(0).default(0),
  customerName: Joi.string().trim().allow('', null),
  customerPhone: Joi.string().trim().allow('', null),
  clientTxnId: Joi.string().trim().required(),
});
