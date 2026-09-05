// api/src/controllers/tableReport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { Table } from '@models/table.model';

/**
 * The organizer's read-only view of table service at one cashless event: what
 * is still OPEN on the floor, what was SETTLED, and — deliberately its own
 * total, not a status filter buried in a list — what was VOIDED, i.e. walked
 * out unpaid. voidedValue is the number that tells an organizer whether table
 * service is costing them money; ownership + cashless is asserted by the same
 * shared guard every other organizer report in this file uses.
 */
export class TableReportController {
  /** GET /api/tickets/events/:eventId/tables */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      const tables = await Table.find({ eventId: event._id }).sort({ createdAt: -1 }).lean();
      const open = tables.filter((t) => t.status === 'open');
      const settled = tables.filter((t) => t.status === 'settled');
      const voided = tables.filter((t) => t.status === 'voided');
      const valueOf = (rows: { subtotal: number }[]) => rows.reduce((total, t) => total + t.subtotal, 0);

      return ApiResponseUtil.success(res, {
        open, settled, voided,
        totals: { openValue: valueOf(open), settledValue: valueOf(settled), voidedValue: valueOf(voided) },
      });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load tables', 500);
    }
  }
}
