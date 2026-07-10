import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { ReportService } from '@services/report.service';
import { reportSchema, resolveReportSchema } from '@validators/community.validator';

const STATUSES = ['open', 'resolved', 'dismissed'];

/**
 * Buyer report filing (POST /api/community/reports) + the platform-wide
 * social moderation queue (GET/POST /api/tickets/reports*, gated by
 * requireSuperAdminOrPermission(MODERATE_SOCIAL) in tickets.route.ts).
 */
export class ReportController {
  /** POST /api/community/reports — authenticateBuyer. */
  static async file(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await ensureUsername(buyer);

      const { error, value } = reportSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const { created } = await ReportService.fileReport(buyer, value);
      return ApiResponseUtil.success(
        res,
        { reported: true },
        created ? 'Report filed' : 'You already have an open report for this',
        created ? 201 : 200
      );
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to file report');
    }
  }

  /** GET /api/tickets/reports?status=open&before=&limit= — admin queue. */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const status = req.query['status'] as string | undefined;
      if (status !== undefined && !STATUSES.includes(status)) {
        return ApiResponseUtil.error(res, 'status must be open, resolved or dismissed', 400);
      }

      let limit: number | undefined;
      const limitRaw = req.query['limit'];
      if (limitRaw !== undefined) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1) {
          return ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
        }
      }
      const before = req.query['before'] as string | undefined;
      if (before !== undefined && !HEX24.test(before)) {
        return ApiResponseUtil.error(res, 'before must be a report id', 400);
      }

      const reports = await ReportService.listQueue({ status: status as any, before, limit });
      return ApiResponseUtil.success(res, reports);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load reports');
    }
  }

  /** POST /api/tickets/reports/:reportId/resolve { action, note? } — admin queue. */
  static async resolve(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const reportId = String(req.params['reportId'] || '');
      if (!HEX24.test(reportId)) return ApiResponseUtil.error(res, 'reportId must be a report id', 400);

      const { error, value } = resolveReportSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const view = await ReportService.resolve(reportId, ticketsUser, value);
      return ApiResponseUtil.success(res, view, 'Report resolved');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to resolve report');
    }
  }
}
