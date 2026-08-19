import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { TagReportService, type TagStatus } from '@services/tagReport.service';

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

  /** GET /api/tickets/events/:eventId/tags */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      // Reject malformed params here so they never reach the aggregation as an
      // invalid ObjectId and surface as a 500.
      const hex24 = /^[0-9a-fA-F]{24}$/;
      const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
      if (cursor && !hex24.test(cursor)) return ApiResponseUtil.badRequest(res, 'invalid cursor');

      const rawLimit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
        return ApiResponseUtil.badRequest(res, 'invalid limit');
      }

      const status = req.query['status'] ? String(req.query['status']) : undefined;
      const allowed = ['active', 'unbound', 'frozen', 'closed'];
      if (status && !allowed.includes(status)) return ApiResponseUtil.badRequest(res, 'invalid status');

      return ApiResponseUtil.success(res, await TagReportService.list(eventId, {
        ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
        ...(cursor ? { cursor } : {}),
        ...(status ? { status: status as TagStatus } : {}),
        ...(req.query['q'] ? { q: String(req.query['q']) } : {}),
      }));
    } catch (err: any) {
      console.error('Tag list error:', err);
      return ApiResponseUtil.error(res, 'Failed to load tags', 500);
    }
  }

  /** GET /api/tickets/events/:eventId/tags/registrations */
  static async registrations(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      const hex24 = /^[0-9a-fA-F]{24}$/;
      const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
      if (cursor && !hex24.test(cursor)) return ApiResponseUtil.badRequest(res, 'invalid cursor');

      const rawLimit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
        return ApiResponseUtil.badRequest(res, 'invalid limit');
      }

      return ApiResponseUtil.success(res, await TagReportService.registrations(eventId, {
        ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
        ...(cursor ? { cursor } : {}),
        ...(req.query['q'] ? { q: String(req.query['q']) } : {}),
      }));
    } catch (err: any) {
      console.error('Tag registrations error:', err);
      return ApiResponseUtil.error(res, 'Failed to load tag registrations', 500);
    }
  }

  /** GET /api/tickets/events/:eventId/tags/:walletId */
  static async detail(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;

      if (!/^[0-9a-fA-F]{24}$/.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const detail = await TagReportService.detail(eventId, walletId);
      if (!detail) return ApiResponseUtil.error(res, 'Tag not found', 404);
      return ApiResponseUtil.success(res, detail);
    } catch (err: any) {
      console.error('Tag detail error:', err);
      return ApiResponseUtil.error(res, 'Failed to load the tag', 500);
    }
  }
}
