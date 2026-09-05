import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { WaiterToken } from '@interfaces/waiter.interface';
import { TableService, TableLabelTakenError } from '@services/table.service';

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

  /** POST /api/waiter/tables — open a new table under a number/label. */
  static async openTable(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) return ApiResponseUtil.badRequest(res, 'label is required');
    try {
      const table = await TableService.open({ eventId: String(event._id), label, openedBy: waiter.waiterId });
      return ApiResponseUtil.created(res, table);
    } catch (e) {
      // Two waiters opening "7" at once: the partial unique index arbitrates,
      // and the loser is told the table is taken, not given a 500.
      if (e instanceof TableLabelTakenError) return ApiResponseUtil.error(res, e.message, 409);
      throw e;
    }
  }

  /** GET /api/waiter/tables — tables at this waiter's event, optionally ?status=open|settled|voided. */
  static async listTables(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
    const tables = await TableService.list(String(event._id), status);
    return ApiResponseUtil.success(res, { tables });
  }
}
