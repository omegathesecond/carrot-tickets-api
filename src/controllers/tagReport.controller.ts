import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { TagReportService } from '@services/tagReport.service';

/**
 * The organizer's read surface over the tags at one cashless event. Writes live
 * in TagAdminController; nothing here mutates a wallet.
 */
export class TagReportController {
  /** GET /api/tickets/events/:eventId/tags/summary */
  static async summary(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      return ApiResponseUtil.success(res, await TagReportService.summary(eventId));
    } catch (err: any) {
      console.error('Tag summary error:', err);
      return ApiResponseUtil.error(res, 'Failed to load the tag summary', 500);
    }
  }
}
