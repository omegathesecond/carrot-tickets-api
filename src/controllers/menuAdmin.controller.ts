import { NextFunction, Request, Response } from 'express';
import { Event } from '@models/event.model';
import { MenuItem } from '@models/menuItem.model';
import { MenuOrder, MenuOrderFulfillmentStatus, fulfillmentTransitionRefusal } from '@models/menuOrder.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { createMenuItemSchema, updateMenuItemSchema, updateMenuOrderFulfillmentSchema } from '@validators/menu.validator';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

// Mirrors StockAdminController.loadOwnedEvent — a menu op is only allowed by
// the owner of the event it belongs to (super-admin bypasses).
async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

export class MenuAdminController {
  /** POST /api/tickets/events/:eventId/menu-items */
  static async createItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const { error, value } = createMenuItemSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const item = await MenuItem.create({ ...value, eventId: event._id });
      ApiResponseUtil.created(res, item);
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/menu-items */
  static async listItems(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const items = await MenuItem.find({ eventId: event._id }).sort({ section: 1, category: 1, displayOrder: 1, name: 1 });
      ApiResponseUtil.success(res, items);
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/menu-items/:id */
  static async updateItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const item = await MenuItem.findById(req.params['id']);
      if (!item) { ApiResponseUtil.notFound(res, 'Menu item not found'); return; }
      const event = await loadOwnedEvent(req, res, String(item.eventId));
      if (!event) return;
      const { error, value } = updateMenuItemSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      Object.assign(item, value);
      await item.save();
      ApiResponseUtil.success(res, item);
    } catch (err) { next(err); }
  }

  /** DELETE /api/tickets/menu-items/:id */
  static async deleteItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const item = await MenuItem.findById(req.params['id']);
      if (!item) { ApiResponseUtil.notFound(res, 'Menu item not found'); return; }
      const event = await loadOwnedEvent(req, res, String(item.eventId));
      if (!event) return;
      await item.deleteOne();
      ApiResponseUtil.success(res, { deleted: true });
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/events/:eventId/menu-orders — organizer view of incoming preorders */
  static async listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const event = await loadOwnedEvent(req, res, String(req.params['eventId'] || ''));
      if (!event) return;
      const orders = await MenuOrder.find({ eventId: event._id }).sort({ createdAt: -1 }).limit(500);
      ApiResponseUtil.success(res, orders);
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/menu-orders/:id — organizer updates the preparation status */
  static async updateOrderFulfillment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const order = await MenuOrder.findById(req.params['id']);
      if (!order) { ApiResponseUtil.notFound(res, 'Order not found'); return; }
      const event = await loadOwnedEvent(req, res, String(order.eventId));
      if (!event) return;
      const { error, value } = updateMenuOrderFulfillmentSchema.validate(req.body || {});
      if (error) { ApiResponseUtil.badRequest(res, error.message); return; }
      const next = value.fulfillmentStatus as MenuOrderFulfillmentStatus;
      const refusal = fulfillmentTransitionRefusal(order, next);
      if (refusal) { ApiResponseUtil.error(res, refusal, 409); return; }
      order.fulfillmentStatus = next;
      await order.save();
      ApiResponseUtil.success(res, order);
    } catch (err) { next(err); }
  }
}
