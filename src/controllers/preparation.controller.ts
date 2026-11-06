import { Request, Response } from 'express';
import Joi from 'joi';
import { PreparationService } from '@services/preparation.service';
import { PREPARATION_CATEGORIES } from '@models/preparation.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { HttpError } from '@utils/httpError.util';

const id = Joi.string().pattern(HEX24);
const text = (max: number) => Joi.string().trim().min(1).max(max);
export const preparationInput = Joi.object({
  category: Joi.string().valid(...PREPARATION_CATEGORIES).required(),
  budget: Joi.number().min(0).max(100000000).precision(2).required(),
  preferredDate: Joi.date().iso().required(),
  location: text(300).required(),
  note: text(1000).allow('').default(''),
  mode: Joi.string().valid('open', 'invite').required(),
  providerIds: Joi.array().items(id).unique().max(20).when('mode', {
    is: 'invite', then: Joi.array().min(1).required(), otherwise: Joi.array().default([]),
  }),
});
export const preparationOfferInput = Joi.object({
  price: Joi.number().min(0).max(100000000).precision(2).required(),
  description: text(2000).required(),
  availableTime: Joi.date().iso().required(),
  location: text(300).required(),
  photos: Joi.array().items(Joi.string().uri({ scheme: ['https'] }).max(1000)).max(8).default([]),
  message: text(1000).allow('').default(''),
  deposit: Joi.number().min(0).max(Joi.ref('price')).precision(2).required(),
  cancellationTerms: text(2000).required(),
});
const filters = Joi.object({
  category: Joi.string().valid(...PREPARATION_CATEGORIES), eventId: id, event: text(100),
  location: text(100), budget: Joi.number().min(0), date: Joi.string().isoDate(),
});
function validate(schema: Joi.Schema, input: unknown) {
  const result = schema.validate(input, { convert: true });
  if (result.error) throw new HttpError(400, result.error.message);
  return result.value;
}
export class PreparationController {
  static handle(action: string) {
    return async (req: Request, res: Response) => {
      try {
        for (const value of Object.values(req.params)) if (!HEX24.test(String(value))) throw new HttpError(400, 'Invalid identifier');
        const eventId = String(req.params.eventId || '');
        const requestId = String(req.params.id || '');
        let data: unknown;
        if (action === 'providerList' || action === 'providerOffer') {
          const vendorId = (req as Request & { ticketsUser?: { vendorId?: string } }).ticketsUser?.vendorId;
          if (!vendorId) throw new HttpError(403, 'Service-provider account required');
          data = action === 'providerList'
            ? await PreparationService.list(String(vendorId), validate(filters, req.query))
            : await PreparationService.offer(requestId, { id: String(vendorId), type: 'vendor', name: '' }, validate(preparationOfferInput, req.body));
        } else {
          const buyer = await resolveBuyerFromRequest(req);
          if (!buyer) throw new HttpError(401, 'Please sign in as a ticket holder');
          switch (action) {
            case 'mine': data = await PreparationService.mine(eventId, buyer); break;
            case 'create': case 'update': data = await PreparationService.save(eventId, buyer, validate(preparationInput, req.body), requestId || undefined); break;
            case 'remove': data = await PreparationService.remove(eventId, buyer, requestId); break;
            case 'accept': data = await PreparationService.accept(eventId, buyer, requestId, String(validate(Joi.object({ offerId: id.required() }), req.body).offerId)); break;
            case 'companions': data = await PreparationService.companions(eventId, buyer); break;
            case 'interest': data = await PreparationService.offer(requestId, { id: String(buyer._id), type: 'buyer', name: buyer.name || 'Attendee', buyer }, validate(preparationOfferInput, req.body)); break;
            default: throw new HttpError(400, 'Unknown action');
          }
        }
        return ApiResponseUtil.success(res, data);
      } catch (error) { return failWithHttpError(res, error, 'Could not update event preparation'); }
    };
  }
}
