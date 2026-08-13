// api/src/controllers/stockReport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { StockReportService } from '@services/stockReport.service';

/**
 * Organiser stock reporting (design 2026-08-13, Slice 4). Read-only surfaces —
 * live board, reconciliation, event dashboard, movements journal. Every method
 * asserts event ownership + cashless via the shared guard, then delegates to
 * the aggregation service. VIEW_REVENUE-gated at the route.
 */
export class StockReportController {
  /** GET /api/tickets/events/:eventId/stock/board */
  static async board(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.board(eventId);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock board', 500);
    }
  }

  /** GET /api/tickets/events/:eventId/stock/reconciliation */
  static async reconciliation(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.reconciliation(eventId, event.startTime);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load reconciliation', 500);
    }
  }

  /** GET /api/tickets/events/:eventId/stock/dashboard */
  static async dashboard(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.dashboard(eventId);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock dashboard', 500);
    }
  }

  /** GET /api/tickets/events/:eventId/stock/movements?productId=&merchantId=&cursor=&limit= */
  static async movements(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.movements({
        eventId,
        productId: req.query.productId ? String(req.query.productId) : undefined,
        merchantId: req.query.merchantId ? String(req.query.merchantId) : undefined,
        cursor: req.query.cursor ? String(req.query.cursor) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return ApiResponseUtil.success(res, data);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock movements', 500);
    }
  }
}
