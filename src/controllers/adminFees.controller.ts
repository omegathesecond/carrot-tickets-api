import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { FeesService } from '@services/fees.service';

/**
 * Fees admin API — the "Fees" tab. Super-admin only (gated in the route).
 * Reports the fees Carrot has collected per event: booking fee + platform
 * commission, with a per-payment-method breakdown.
 */
export class AdminFeesController {
  /**
   * GET /api/tickets/admin/fees?search=&eventId=&startDate=&endDate=&page=&limit=
   */
  static async getFees(req: Request, res: Response): Promise<any> {
    try {
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '25'), 10) || 25));
      const search = String(req.query['search'] ?? '').trim();
      const eventId = String(req.query['eventId'] ?? '').trim();

      const startRaw = String(req.query['startDate'] ?? '').trim();
      const endRaw = String(req.query['endDate'] ?? '').trim();
      const startDate = startRaw ? new Date(startRaw) : undefined;
      const endDate = endRaw ? new Date(endRaw) : undefined;

      const result = await FeesService.getFeesByEvent({
        page,
        limit,
        search: search || undefined,
        eventId: eventId || undefined,
        startDate: startDate && !isNaN(startDate.getTime()) ? startDate : undefined,
        endDate: endDate && !isNaN(endDate.getTime()) ? endDate : undefined,
      });

      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get fees by event error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load fees', 500);
    }
  }
}
