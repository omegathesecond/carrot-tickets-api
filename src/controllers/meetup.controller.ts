import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { MeetupService } from '@services/meetup.service';
import { MeetupStatus } from '@models/meetupRequest.model';

const STATUSES: MeetupStatus[] = ['pending', 'accepted', 'declined'];

export class MeetupController {
  /** POST /api/social/meetups { targetId } */
  static async request(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const targetId = String(req.body?.targetId || '');
      const result = await MeetupService.request(buyer, targetId);
      return ApiResponseUtil.success(res, result, 'Meetup requested');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to send meetup request');
    }
  }

  /** GET /api/social/meetups?status= — the viewer's meetups at `status`, in
   *  BOTH directions (sent + received). Each row carries `direction` so the UI
   *  can offer accept/deny (incoming) vs cancel (outgoing). */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const status = String(req.query['status'] || 'pending') as MeetupStatus;
      if (!STATUSES.includes(status)) return ApiResponseUtil.error(res, 'Invalid status', 400);
      const meetups = await MeetupService.listByStatus(buyer, status);
      return ApiResponseUtil.success(res, { meetups });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load meetups');
    }
  }

  /** POST /api/social/meetups/:id/accept */
  static async accept(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await MeetupService.accept(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { status: 'accepted' }, 'Meetup accepted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to accept meetup');
    }
  }

  /** POST /api/social/meetups/:id/decline */
  static async decline(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await MeetupService.decline(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { status: 'declined' }, 'Meetup declined');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to decline meetup');
    }
  }

  /** DELETE /api/social/meetups/:id */
  static async cancel(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await MeetupService.cancel(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { ok: true }, 'Meetup cancelled');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to cancel meetup');
    }
  }
}
