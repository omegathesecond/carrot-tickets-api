import Joi from 'joi';
import { MAX_TOPUP_CENTS } from '@services/wallet.service';

const uid = Joi.string().trim().lowercase().pattern(/^[0-9a-f]{8,}$/);

/**
 * POST /api/reseller/wallets/cash-topup — either an already-bound band OR a
 * ticketId, never both (spec §5.2). Amount is integer minor units (cents),
 * capped at MAX_TOPUP_CENTS as a safety ceiling against ledger inflation;
 * clientTxnId makes the top-up idempotent (WalletService.topUpCash).
 */
export const cashTopupSchema = Joi.object({
  ticketId: Joi.string().trim().regex(/^[0-9a-fA-F]{24}$/),
  bandUid: uid,
  eventId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required(),
  amount: Joi.number().integer().min(1).max(MAX_TOPUP_CENTS).required(),
  clientTxnId: Joi.string().trim().required(),
}).xor('ticketId', 'bandUid');

