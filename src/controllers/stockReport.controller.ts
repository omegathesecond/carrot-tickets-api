// api/src/controllers/stockReport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getScope, scopeOwner } from '@middleware/tradingScope.middleware';
import { StockReportService, ReconWindow } from '@services/stockReport.service';
import { StockReconciliationPdfService } from '@services/stockReconciliationPdf.service';
import { EVENT_TIMEZONE, startOfLocalDay } from '@utils/eventTime.util';
import { scopeIds } from '@utils/tradingScope.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A download filename an organiser can file without renaming: the event or
 * venue, then the date it describes. Anything outside [A-Za-z0-9-] is stripped,
 * so a name carrying a quote or a slash cannot break out of the
 * Content-Disposition header.
 */
function reconciliationFilename(ownerName: string): string {
  const slug = ownerName.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'stock';
  const date = new Date().toLocaleDateString('en-CA', { timeZone: EVENT_TIMEZONE }); // YYYY-MM-DD
  return `stock-reconciliation-${slug}-${date}.pdf`;
}

/**
 * The reconciliation window. An event reconciles from its doors (startTime).
 * A venue takes `?from=&to=` ISO instants, defaulting to today in
 * Africa/Mbabane; `to` defaults to a day after `from`. Null after a 400.
 */
function reconWindow(req: Request, res: Response): ReconWindow | null {
  const scope = getScope(req);
  if (scope.kind === 'event') return { doorsAt: (req as any).scopeEvent.startTime };
  const parse = (v: unknown) => (v === undefined ? undefined : new Date(String(v)));
  const from = parse(req.query['from']) ?? startOfLocalDay(new Date());
  const to = parse(req.query['to']) ?? new Date(from.getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    ApiResponseUtil.badRequest(res, 'from and to must be ISO dates'); return null;
  }
  if (from.getTime() >= to.getTime()) { ApiResponseUtil.badRequest(res, 'from must be before to'); return null; }
  return { from, to };
}

/** "1 Oct 2026, 00:00 – 2 Oct 2026, 00:00" in Eswatini time — a venue PDF's subtitle. */
function rangeLabel(from: Date, to: Date): string {
  const f = (d: Date) => d.toLocaleString('en-GB', {
    timeZone: EVENT_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${f(from)} – ${f(to)}`;
}

/**
 * Stock reporting for an event (design 2026-08-13, Slice 4) or a venue (venue
 * trading Phase 2). Read-only. The route's scope middleware has already
 * asserted ownership (and, for events, cashless); VIEW_REVENUE-gated at the route.
 */
export class StockReportController {
  /** GET /api/tickets/events/:eventId/stock/board | GET /api/tickets/venue/stock/board */
  static async board(req: Request, res: Response): Promise<any> {
    try {
      const data = await StockReportService.board(scopeIds(getScope(req)));
      return ApiResponseUtil.success(res, { ...scopeOwner(req), ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock board', 500);
    }
  }

  /** GET …/stock/reconciliation (venue: ?from=&to=) */
  static async reconciliation(req: Request, res: Response): Promise<any> {
    try {
      const window = reconWindow(req, res);
      if (!window) return;
      const data = await StockReportService.reconciliation(scopeIds(getScope(req)), window);
      return ApiResponseUtil.success(res, { ...scopeOwner(req), ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load reconciliation', 500);
    }
  }

  /**
   * GET …/stock/reconciliation.pdf — the SAME reconciliation as above, rendered
   * for printing, so the page handed to a stall manager cannot disagree with
   * the one on screen.
   */
  static async reconciliationPdf(req: Request, res: Response): Promise<any> {
    try {
      const window = reconWindow(req, res);
      if (!window) return;
      const data = await StockReportService.reconciliation(scopeIds(getScope(req)), window);
      const owner = scopeOwner(req);
      const name = 'event' in owner ? owner.event.name : owner.venue.name;
      const subtitle = 'doorsAt' in window ? (req as any).scopeEvent.venue : rangeLabel(window.from, window.to);
      const buffer = await StockReconciliationPdfService.buildPdfBuffer({ name, subtitle }, data);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${reconciliationFilename(name)}"`);
      return res.send(buffer);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to build the reconciliation PDF', 500);
    }
  }

  /** GET …/stock/dashboard */
  static async dashboard(req: Request, res: Response): Promise<any> {
    try {
      const data = await StockReportService.dashboard(scopeIds(getScope(req)));
      return ApiResponseUtil.success(res, { ...scopeOwner(req), ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock dashboard', 500);
    }
  }

  /** GET …/stock/movements?productId=&merchantId=&cursor=&limit= */
  static async movements(req: Request, res: Response): Promise<any> {
    try {
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
      const data = await StockReportService.movements({ ...scopeIds(getScope(req)), productId, merchantId, cursor, limit });
      return ApiResponseUtil.success(res, data);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock movements', 500);
    }
  }
}
