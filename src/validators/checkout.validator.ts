import Joi from 'joi';
import { MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';

export const couponCodeSchema = Joi.string().trim().uppercase().pattern(/^CT-[A-F0-9]{16}$/);

/**
 * The cart a buyer is checking out: one entry per tier, 1..20 lines.
 *
 * MAX_TICKETS_PER_ORDER caps the WHOLE cart, not each line — otherwise the
 * order limit could be exceeded by splitting across tiers, the same hole the
 * per-account cap has (see resolveCart). Shared by every purchase rail so no
 * two of them can disagree about what a valid cart is.
 */
export const cartItemsSchema = Joi.array()
  .items(Joi.object({
    ticketTypeId: Joi.string().hex().length(24).required(),
    quantity: Joi.number().integer().min(1).max(MAX_TICKETS_PER_ORDER).required(),
  }))
  .min(1)
  .max(20)
  .custom((value: Array<{ quantity: number }>, helpers) => {
    const total = value.reduce((sum, l) => sum + l.quantity, 0);
    if (total > MAX_TICKETS_PER_ORDER) {
      return helpers.message({ custom: `You can buy at most ${MAX_TICKETS_PER_ORDER} tickets per order` } as never);
    }
    return value;
  })
  .optional();

