import { Request, Response } from 'express';
import { EventService } from '@services/event.service';
import { R2Service } from '@utils/r2.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { createEventSchema } from '@validators/tickets.validator';
import { EventStatus } from '@interfaces/event.interface';

type UploadedFiles = { poster?: Express.Multer.File[]; media?: Express.Multer.File[] };

/**
 * Consumer self-listing: a signed-in buyer submits an event from the app. It
 * REUSES the organizer dashboard's creation path — same `createEventSchema`
 * validation, same `EventService.createEvent`, same `R2Service.uploadEventMedia`
 * — but stamps it PENDING_APPROVAL with `submittedByBuyerId` (no vendor), so it
 * enters the existing admin review queue and stays hidden from public listings
 * until approved.
 */
export class CommunityEventSubmitController {
  static async submit(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to list an event');

      const body: Record<string, unknown> = { ...req.body };

      // Community self-listings are LISTINGS, not hosted events: they put the
      // event on the feed/calendar and nothing more. Selling through Carrot
      // requires a real organizer account (payouts, scanning, settlement), so
      // ticket tiers are refused here outright rather than quietly dropped —
      // a caller that asked to sell must be told it did not happen, and where
      // to go instead. The current app never sends this field.
      if (body['ticketTypes'] != null && body['ticketTypes'] !== '' && body['ticketTypes'] !== '[]') {
        return ApiResponseUtil.error(
          res,
          'Community listings cannot sell tickets. Create your event on the organizer dashboard to sell tickets on Carrot.',
          400,
        );
      }
      delete body['ticketTypes'];
      // URLs are set from the uploaded files below, never trusted from the body.
      delete body['posterUrl'];
      delete body['galleryImages'];
      delete body['thumbnailUrl'];

      const { error, value } = createEventSchema.validate(body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const files = (req.files as UploadedFiles) || {};
      const posterFile = files.poster?.[0];
      if (!posterFile) {
        return ApiResponseUtil.error(res, 'An event poster image is required', 400);
      }

      // Same creation logic the dashboard uses — just buyer-submitted + pending.
      const event = await EventService.createEvent({
        ...value,
        submittedByBuyerId: String(buyer._id),
        status: EventStatus.PENDING_APPROVAL,
      });

      const poster = await R2Service.uploadEventMedia(
        String(event._id), 'poster', posterFile.originalname, posterFile.buffer, posterFile.mimetype,
      );
      event.posterUrl = poster.url;

      const mediaFiles = files.media ?? [];
      if (mediaFiles.length) {
        const uploaded = await Promise.all(
          mediaFiles.map((f) =>
            R2Service.uploadEventMedia(String(event._id), 'gallery', f.originalname, f.buffer, f.mimetype),
          ),
        );
        event.galleryImages = uploaded.map((u) => u.url);
      }
      await event.save();

      return ApiResponseUtil.created(res, event, "Event submitted — we'll review it and publish it shortly.");
    } catch (error: any) {
      console.error('Community event submit error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to submit event');
    }
  }
}
