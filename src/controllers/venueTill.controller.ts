import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { MerchantToken } from '@interfaces/merchant.interface';
import { hexId } from '@utils/controllerHelpers.util';
import { VENUE_ONLY } from '@middleware/waiterKind.middleware';
import { VenueTableService } from '@services/venueTable.service';
import { TableAlreadySettledError, TableFulfilmentNotFoundError, TableFulfilmentStateError } from '@services/table.service';
import { VenueSaleService, CounterSaleRefusedError } from '@services/venueSale.service';
import { StockDeclinedError } from '@services/stock.service';
import { ChargeIdempotencyMismatchError } from '@services/merchant.service';
import { StockAlertService } from '@services/stockAlert.service';
import { counterSaleSchema } from '@validators/venueSelling.validator';

const ORDER_STATUSES = ['sent', 'handed_out', 'collected'] as const;

export interface VenueTill { venueId: string; merchantId: string; merchantOperatorId: string; operatorName: string; merchantName: string; vendorId: string }

/** The venue till behind this request — or null after a 403 for an EVENT till. */
export function venueTillOf(req: Request, res: Response): VenueTill | null {
  const m = (req as any).merchant as MerchantToken;
  if (!m.venueId) { ApiResponseUtil.forbidden(res, VENUE_ONLY); return null; }
  return {
    venueId: m.venueId, merchantId: m.merchantId, merchantOperatorId: m.merchantOperatorId,
    operatorName: m.operatorName, merchantName: m.name,
    vendorId: String(((req as any).merchantVenue as { vendorId: unknown }).vendorId),
  };
}

/**
 * The venue till (venue trading Phase 3): the rounds waiters send it, and
 * counter sales. Handlers answer; they never throw.
 */
export class VenueTillController {
  /** GET /api/merchant/orders?status= — this stall's queue. */
  static async orders(req: Request, res: Response): Promise<any> {
    const till = venueTillOf(req, res);
    if (!till) return;
    const raw = req.query['status'];
    const status = ORDER_STATUSES.find((s) => s === raw);
    if (raw !== undefined && !status) return ApiResponseUtil.badRequest(res, 'Unknown order status');
    const orders = await VenueTableService.ordersForStall({ venueId: till.venueId, merchantId: till.merchantId, status });
    return ApiResponseUtil.success(res, { orders });
  }

  /** POST /api/merchant/tables/:tableId/orders/:orderId/hand-out — the round leaves the counter. */
  static async handOut(req: Request, res: Response): Promise<any> {
    const till = venueTillOf(req, res);
    if (!till) return;
    const tableId = hexId(req.params['tableId']);
    const orderId = hexId(req.params['orderId']);
    if (!tableId || !orderId) return ApiResponseUtil.notFound(res, 'no handover for this stall on that table');
    try {
      const table = await VenueTableService.handOutOrder({ venueId: till.venueId, tableId, orderId, merchantId: till.merchantId, handedOutBy: till.merchantOperatorId });
      return ApiResponseUtil.success(res, await VenueTableService.stallOrderView(table, orderId));
    } catch (e: any) {
      if (e instanceof TableFulfilmentNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      if (e instanceof TableFulfilmentStateError || e instanceof TableAlreadySettledError) return ApiResponseUtil.error(res, e.message, 409);
      console.error('Hand-out failed', e);
      return ApiResponseUtil.error(res, e?.message || 'Could not hand out the order', 500);
    }
  }

  /** POST /api/merchant/sales { clientTxnId, items, payment: { tenders } } — a counter sale. */
  static async sale(req: Request, res: Response): Promise<any> {
    const till = venueTillOf(req, res);
    if (!till) return;
    const { error, value } = counterSaleSchema.validate(req.body ?? {}, { stripUnknown: true });
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const { charge, payment } = await VenueSaleService.counterSale({
        venueId: till.venueId, merchantId: till.merchantId, merchantName: till.merchantName,
        merchantOperatorId: till.merchantOperatorId, operatorName: till.operatorName,
        clientTxnId: value.clientTxnId, items: value.items, tenders: value.payment.tenders,
      });
      // Best-effort, off the money path: a notification failure logs loudly but never affects the sale.
      StockAlertService.evaluateAfterSale({
        vendorId: till.vendorId, merchantId: till.merchantId,
        productIds: value.items.map((i: { productId: string }) => i.productId),
      }).catch((err) => console.error('[low-stock] evaluateAfterSale failed', err));
      return ApiResponseUtil.success(res, {
        amount: charge.amount, tips: payment.tips, items: charge.items,
        payment: { id: String(payment._id), tenders: payment.tenders, applied: payment.applied, tips: payment.tips, at: payment.at },
      });
    } catch (e: any) {
      if (e instanceof StockDeclinedError) return ApiResponseUtil.error(res, 'Out of stock', 409, { reason: e.reason, productId: e.productId, available: e.available });
      if (e instanceof CounterSaleRefusedError) return ApiResponseUtil.error(res, e.message, 400, { reason: e.reason, ...e.detail });
      if (e instanceof ChargeIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409, { reason: e.reason });
      console.error('Counter sale failed', e);
      return ApiResponseUtil.error(res, e?.message || 'Could not complete the sale', 500);
    }
  }
}
