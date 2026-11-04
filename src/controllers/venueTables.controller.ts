import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { hexId } from '@utils/controllerHelpers.util';
import { venueIdOf } from '@middleware/tradingScope.middleware';
import { TableService } from '@services/table.service';
import { VenueTableService } from '@services/venueTable.service';
import { TABLE_STATUSES, answerTableError } from '@controllers/venueWaiter.controller';

/** Shown on every row of the voided list, so it is a note, not an essay. */
const MAX_REASON = 200;

/**
 * The manager's view of the floor (venue trading Phase 3). Read-only apart
 * from the walkout: the dashboard never opens a table, adds a round or takes a
 * payment — every sale stays attributed to a named waiter or till person.
 */
export class VenueTablesController {
  /** GET /api/tickets/venue/tables?status=open|settled|voided */
  static async list(req: Request, res: Response): Promise<any> {
    const raw = req.query['status'];
    const status = raw === undefined ? 'open' : TABLE_STATUSES.find((s) => s === raw);
    if (!status) return ApiResponseUtil.badRequest(res, 'Unknown table status');
    return ApiResponseUtil.success(res, await VenueTableService.dashboardList({ venueId: venueIdOf(req), status }));
  }

  /** GET /api/tickets/venue/tables/:id */
  static async detail(req: Request, res: Response): Promise<any> {
    const tableId = hexId(req.params['id']);
    const table = tableId ? await VenueTableService.dashboardDetail({ venueId: venueIdOf(req), tableId }) : null;
    if (!table) return ApiResponseUtil.notFound(res, 'Table not found');
    return ApiResponseUtil.success(res, table);
  }

  /** POST /api/tickets/venue/tables/:id/void { reason } — close a walkout. Stock is NOT returned. */
  static async void(req: Request, res: Response): Promise<any> {
    const tableId = hexId(req.params['id']);
    if (!tableId) return ApiResponseUtil.notFound(res, 'Table not found');
    const venueId = venueIdOf(req);
    const user = (req as any).ticketsUser as { userId?: string; vendorId?: string };
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length > MAX_REASON) return ApiResponseUtil.badRequest(res, `reason must be ${MAX_REASON} characters or fewer`);
    try {
      await TableService.voidTable({ venueId, tableId, reason, voidedBy: String(user.userId ?? user.vendorId) });
    } catch (e) { return answerTableError(res, e, 'Could not close the table'); }
    return ApiResponseUtil.success(res, await VenueTableService.dashboardDetail({ venueId, tableId }));
  }
}
