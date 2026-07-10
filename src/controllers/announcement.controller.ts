import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { Event } from '@models/event.model';
import { MessageService } from '@services/message.service';
import { announcementSchema } from '@validators/community.validator';

export class AnnouncementController {
  /** POST /api/tickets/events/:eventId/announcements — vendor, own events only. */
  static async post(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const eventId = String(req.params['eventId'] || '');
      if (!HEX24.test(eventId)) return ApiResponseUtil.error(res, 'eventId must be an event id', 400);

      const { error, value } = announcementSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const event = await Event.findById(eventId).select('vendorId');
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!ticketsUser?.isSuperAdmin && String(event.vendorId) !== String(vendorId)) {
        return ApiResponseUtil.error(res, 'You can only post announcements for your own events', 403);
      }

      const view = await MessageService.postAnnouncement(eventId, vendorId, value.body);
      return ApiResponseUtil.success(res, view, 'Announcement posted', 201);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post announcement');
    }
  }
}
