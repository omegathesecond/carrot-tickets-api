import Joi from 'joi';
import { objectId } from '@validators/stock.validator';
import { MAX_LINES, MAX_QTY_PER_LINE } from '@validators/merchant.validator';
import { MAX_CHARGE_CENTS } from '@services/merchant.service';
import { TENDER_METHODS } from '@interfaces/venuePayment.interface';

/**
 * Every id in a selling request body, lower-cased. HEX24 accepts either case
 * but `String(ObjectId)` is always lower, and the services key maps by it — an
 * UPPER-CASE id would pass validation, miss the map and end in a 500. The
 * shared `objectId` stays as it is: event validators use it.
 */
const id = objectId.lowercase();

/** A client-chosen idempotency key: the app sends the same one when it retries. */
const clientTxnId = Joi.string().trim().min(1).max(100).required();
const qty = Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required();

/** POST /api/waiter/tables/:id/orders */
export const roundSchema = Joi.object({
  clientTxnId,
  items: Joi.array().items(Joi.object({ merchantId: id.required(), productId: id.required(), qty })).min(1).max(MAX_LINES).required(),
});

const money = Joi.number().integer().min(0).max(MAX_CHARGE_CENTS);

/** One or more ways a payment was made. A tip rides on its tender. */
export const tendersSchema = Joi.array().items(Joi.object({
  method: Joi.string().valid(...TENDER_METHODS).required(),
  amount: money.required(),
  tip: money.default(0),
  reference: Joi.string().trim().max(64).allow(''),
})).min(1).max(4).required();

/** POST /api/waiter/tables/:id/payments — `lines` only when the guest pays for specific items. */
export const tablePaymentSchema = Joi.object({
  clientTxnId,
  tenders: tendersSchema,
  lines: Joi.array().items(Joi.object({ lineId: id.required(), qty })).min(1).max(MAX_LINES),
});

/** POST /api/merchant/sales — a counter sale, paid in full at once. */
export const counterSaleSchema = Joi.object({
  clientTxnId,
  items: Joi.array().items(Joi.object({ productId: id.required(), qty })).min(1).max(MAX_LINES).required(),
  payment: Joi.object({ tenders: tendersSchema }).required(),
});
