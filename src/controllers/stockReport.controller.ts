// api/src/controllers/stockReport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { StockReportService } from '@services/stockReport.service';
import { StockReconciliationPdfService } from '@services/stockReconciliationPdf.service';
import { EVENT_TIMEZONE } from '@utils/eventTime.util';

/**
 * A download filename an organiser can file without renaming: the event, then
 * the date it describes. Anything outside [A-Za-z0-9-] is stripped, so an event
 * name carrying a quote or a slash cannot break out of the Content-Disposition
 * header.
 */
function reconciliationFilename(eventName: string): string {
  const slug = eventName.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
  const date = new Date().toLocaleDateString('en-CA', { timeZone: EVENT_TIMEZONE }); // YYYY-MM-DD
  return `stock-reconciliation-${slug}-${date}.pdf`;
}

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

  /**
   * GET /api/tickets/events/:eventId/stock/reconciliation.pdf
   *
   * The same reconciliation as above, rendered for printing. It calls the SAME
   * service method the JSON endpoint calls, so the page an organiser hands a
   * stall manager cannot disagree with the one on their screen.
   */
  static async reconciliationPdf(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      const data = await StockReportService.reconciliation(eventId, event.startTime);
      const buffer = await StockReconciliationPdfService.buildPdfBuffer(
        { name: event.name, venue: (event as any).venue },
        data,
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${reconciliationFilename(event.name)}"`);
      return res.send(buffer);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to build the reconciliation PDF', 500);
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

      // Reject malformed query params with a clean 400 rather than letting them
      // reach the aggregation as NaN / an invalid ObjectId and surface as a 500.
      const hex24 = /^[0-9a-fA-F]{24}$/;
      const productId = req.query.productId ? String(req.query.productId) : undefined;
      const merchantId = req.query.merchantId ? String(req.query.merchantId) : undefined;
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
      if (productId && !hex24.test(productId)) { ApiResponseUtil.badRequest(res, 'invalid productId'); return; }
      if (merchantId && !hex24.test(merchantId)) { ApiResponseUtil.badRequest(res, 'invalid merchantId'); return; }
      if (cursor && !hex24.test(cursor)) { ApiResponseUtil.badRequest(res, 'invalid cursor'); return; }
      let limit: number | undefined;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isFinite(limit) || limit < 1) { ApiResponseUtil.badRequest(res, 'invalid limit'); return; }
      }

      const data = await StockReportService.movements({ eventId, productId, merchantId, cursor, limit });
      return ApiResponseUtil.success(res, data);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock movements', 500);
    }
  }
}
