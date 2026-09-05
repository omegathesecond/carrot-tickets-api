import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { WaiterToken } from '@interfaces/waiter.interface';
import { TableService, TableLabelTakenError } from '@services/table.service';
import { StockDeclinedError } from '@services/stock.service';

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

  /** POST /api/waiter/tables/:id/items — add an item from a stall, moving its stock. */
  static async addItem(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    const { merchantId, productId, qty } = req.body || {};
    if (!merchantId || !productId) return ApiResponseUtil.badRequest(res, 'merchantId and productId are required');
    if (!Number.isInteger(qty) || qty <= 0) return ApiResponseUtil.badRequest(res, 'qty must be a positive whole number');
    try {
      const table = await TableService.addItem({
        tableId: req.params['id']!, eventId: String(event._id), merchantId, productId, qty, addedBy: waiter.waiterId,
      });
      return ApiResponseUtil.success(res, table);
    } catch (e) {
      // Out of stock at that stall — 409, distinct from a bad request: the
      // table/stall/product were all fine, the shelf just ran out.
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, 'Insufficient stock at that stall', 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      const msg = (e as Error)?.message || 'Could not add item';
      const status = /not open/i.test(msg) ? 409 : /not sold at that stall|not found/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /** DELETE /api/waiter/tables/:id/items/:lineId — remove a mis-punched line, returning its stock. */
  static async removeItem(req: Request, res: Response): Promise<any> {
    const event = await loadWaiterEvent(req, res);
    if (!event) return;
    const waiter = (req as any).waiter as WaiterToken;
    try {
      const table = await TableService.removeItem({
        tableId: req.params['id']!, lineId: req.params['lineId']!, removedBy: waiter.waiterId,
      });
      return ApiResponseUtil.success(res, table);
    } catch (e) {
      const msg = (e as Error)?.message || 'Could not remove item';
      // "table not found"/"line not found on this table" are both 404s — the
      // URL named a resource that isn't there; "not open" is 409 — the
      // resource exists but the table has already moved past editable state.
      const status = /not open/i.test(msg) ? 409 : /not found/i.test(msg) ? 404 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }
}
