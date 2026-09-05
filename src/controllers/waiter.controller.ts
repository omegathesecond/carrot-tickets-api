import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { WaiterToken } from '@interfaces/waiter.interface';

/**
 * Load the event this waiter is working and assert they may act on it. Every
 * table route goes through here, so the "is this my show, and is it even
 * cashless" question is answered in exactly one place. Returns null having
 * ALREADY answered the response.
 */
export async function loadWaiterEvent(req: Request, res: Response): Promise<any | null> {
  const waiter = (req as any).waiter as WaiterToken;
  if (!waiter.eventId) { ApiResponseUtil.forbidden(res, 'No event on this waiter'); return null; }
  const event = await Event.findById(waiter.eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  if (!event.cashless) { ApiResponseUtil.error(res, 'Event is not cashless', 400); return null; }
  return event;
}

export class WaiterController {
  /** GET /api/waiter/events — the one event this waiter works. */
  static async getEvents(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    return ApiResponseUtil.success(res, {
      events: [{
        id: String(event._id), name: event.name, venue: event.venue,
        eventDate: event.eventDate,
      }],
    });
  }
}
