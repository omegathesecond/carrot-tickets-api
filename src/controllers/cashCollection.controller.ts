import { Request, Response } from 'express';
import { Event } from '@models/event.model';
import { CashCollectionService } from '@services/cashCollection.service';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HEX24, failWithHttpError } from '@utils/controllerHelpers.util';
import { HttpError } from '@utils/httpError.util';

async function cashierEvent(req: Request) {
  const eventId = String(req.body.eventId ?? req.query.eventId ?? '');
  if (!HEX24.test(eventId)) throw new HttpError(400, 'A valid event ID is required');
  const event = await Event.findById(eventId).lean();
  if (!event) throw new HttpError(404, 'Event not found');
  if (!event.cashless) throw new HttpError(400, 'Event is not cashless');
  return event;
}
export class CashCollectionController {
  static async desk(req: Request, res: Response) {
    try { return ApiResponseUtil.success(res, await CashCollectionService.desk(await cashierEvent(req), (req as any).cashier.cashierId)); }
    catch (e) { return failWithHttpError(res, e, 'Could not load cash desk'); }
  }
  static async create(req: Request, res: Response) {
    try { return ApiResponseUtil.success(res, await CashCollectionService.create(await cashierEvent(req), (req as any).cashier.cashierId, req.body)); }
    catch (e) { return failWithHttpError(res, e, 'Could not record cash collection'); }
  }
  static async resolve(req: Request, res: Response) {
    try {
      const decision = req.body.decision;
      if (!['confirm', 'reject', 'cancel'].includes(decision)) throw new HttpError(400, 'Choose confirm, reject or cancel');
      return ApiResponseUtil.success(res, await CashCollectionService.resolve(await cashierEvent(req), (req as any).cashier.cashierId, String(req.params.id), decision, req.body.pin));
    } catch (e) { return failWithHttpError(res, e, 'Could not update cash collection'); }
  }
  static async report(req: Request, res: Response) {
    try {
      const eventId = String(req.params.eventId);
      if (!HEX24.test(eventId)) throw new HttpError(400, 'A valid event ID is required');
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      return ApiResponseUtil.success(res, { currency: event.currency, ...await CashCollectionService.report(eventId) });
    } catch (e) { return failWithHttpError(res, e, 'Could not load cash collections'); }
  }
}
