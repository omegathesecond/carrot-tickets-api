import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { hexId } from '@utils/controllerHelpers.util';
import { enumParam, textParam } from '@utils/queryParams.util';
import { parseDayRange } from '@utils/eventTime.util';
import { venueIdOf } from '@middleware/tradingScope.middleware';
import { TENDER_METHODS } from '@interfaces/venuePayment.interface';
import { PaymentFilters, VenuePaymentService } from '@services/venuePayment.service';

const SOURCES = ['table', 'counter'] as const;

/** A positive whole number from a query value: `fallback` when absent, null when it is anything else. */
function positiveInt(value: unknown, fallback: number, max: number): number | null {
  const raw = textParam(value);
  if (raw === null) return null;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** An object id from a query value, lower-cased: undefined when absent, null when it is not one. */
function idParam(value: unknown): string | undefined | null {
  const raw = textParam(value);
  if (raw === null) return null;
  if (!raw) return undefined;
  return hexId(raw);
}

/** The Transactions tab: every payment a venue took. Read-only. */
export class VenuePaymentsController {
  /** GET /api/tickets/venue/payments */
  static async list(req: Request, res: Response): Promise<any> {
    const q = req.query;
    const range = parseDayRange(q['from'], q['to']);
    if ('error' in range) return ApiResponseUtil.badRequest(res, range.error);
    const method = enumParam(textParam(q['method']), TENDER_METHODS);
    if (!method) return ApiResponseUtil.badRequest(res, 'Unknown payment method');
    const source = enumParam(textParam(q['source']), SOURCES);
    if (!source) return ApiResponseUtil.badRequest(res, 'Unknown payment source');
    const staffId = idParam(q['staffId']);
    if (staffId === null) return ApiResponseUtil.badRequest(res, 'Invalid staffId');
    const merchantId = idParam(q['merchantId']);
    if (merchantId === null) return ApiResponseUtil.badRequest(res, 'Invalid merchantId');
    const reference = textParam(q['reference']);
    if (reference === null) return ApiResponseUtil.badRequest(res, 'Invalid reference');
    const page = positiveInt(q['page'], 1, 100000);
    if (page === null) return ApiResponseUtil.badRequest(res, 'Invalid page');
    const limit = positiveInt(q['limit'], 25, 100);
    if (limit === null) return ApiResponseUtil.badRequest(res, 'Invalid limit');

    const filters: PaymentFilters = {
      ...range,
      ...(method.value ? { method: method.value } : {}), ...(source.value ? { source: source.value } : {}),
      ...(staffId ? { staffId } : {}), ...(merchantId ? { merchantId } : {}), ...(reference ? { reference } : {}),
    };
    return ApiResponseUtil.success(res, await VenuePaymentService.list(venueIdOf(req), filters, page, limit));
  }

  /** GET /api/tickets/venue/payments/:id */
  static async detail(req: Request, res: Response): Promise<any> {
    const id = hexId(req.params['id']);
    const payment = id ? await VenuePaymentService.detail(venueIdOf(req), id) : null;
    if (!payment) return ApiResponseUtil.notFound(res, 'Payment not found');
    return ApiResponseUtil.success(res, payment);
  }
}
