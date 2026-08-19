// api/src/controllers/organizerCashless.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { OrganizerCashlessService } from '@services/organizerCashless.service';

/**
 * Load the event and assert the caller owns it (or is platform staff), mirroring
 * the vendor-ownership guard in TicketsController.checkInTicket — an organizer
 * may only see their OWN event's cashless activity, never another vendor's.
 */
export async function loadOwnedCashlessEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  const ticketsUser = (req as any).ticketsUser;
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.error(res, 'Event not found', 404); return null; }
  if (!event.cashless) { ApiResponseUtil.error(res, 'Event is not cashless', 400); return null; }
  if (!ticketsUser?.isSuperAdmin && String(event.vendorId) !== ticketsUser?.vendorId) {
    ApiResponseUtil.error(res, 'Event belongs to a different vendor', 403); return null;
  }
  return event;
}

export class OrganizerCashlessController {
  /** GET /api/tickets/events/:eventId/cashless/summary */
  static async summary(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await OrganizerCashlessService.summary(eventId);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load cashless summary', 500);
    }
  }

  /** GET /api/tickets/events/:eventId/cashless/transactions?type=&tagUid=&page=&limit= */
  static async transactions(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const rawType = String(req.query.type || '');
      const type = ['topup', 'withdrawal', 'purchase'].includes(rawType) ? (rawType as any) : undefined;
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      // Only forward a tag search that has content: an empty ?tagUid= is the
      // dashboard's cleared search box, which must read as "no filter" rather
      // than as a UID that matches nothing.
      const tagUid = String(req.query.tagUid || '').trim();
      const data = await OrganizerCashlessService.transactions({
        eventId, type, page, limit, ...(tagUid ? { tagUid } : {}),
      });
      return ApiResponseUtil.success(res, data);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load cashless transactions', 500);
    }
  }
}
