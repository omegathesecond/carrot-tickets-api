// api/src/controllers/merchantAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { Merchant } from '@models/merchant.model';
import { Event } from '@models/event.model';
import { MerchantService } from '@services/merchant.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

/**
 * A merchant (in-event vendor) is scoped to ONE event, so every op is guarded
 * by the caller owning that event — mirroring the vendor-ownership check in
 * TicketsController.checkInTicket. Returns the event, or null after sending the
 * right 4xx.
 */
export async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

export class MerchantAdminController {
  /** GET /api/tickets/merchants?eventId= — vendors at one (owned) event. */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const eventId = String(req.query['eventId'] || '');
      const event = await loadOwnedEvent(req, res, eventId);
      if (!event) return;
      const merchants = await Merchant.find({ eventId }).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, merchants);
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/merchants { eventId, name, commissionPercent } */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { eventId, name } = req.body || {};
      const event = await loadOwnedEvent(req, res, String(eventId || ''));
      if (!event) return;
      if (!name || typeof name !== 'string' || !name.trim()) {
        ApiResponseUtil.badRequest(res, 'name is required'); return;
      }
      const commissionPercent = Number(req.body.commissionPercent);
      const commission = Number.isFinite(commissionPercent)
        ? Math.min(100, Math.max(0, commissionPercent))
        : 0;

      // No credentials are issued here: a stall does not log in. The people
      // who work its till are MerchantOperators, created separately, each
      // with their own loginCode + PIN.
      const merchant = await Merchant.create({
        name: name.trim(),
        eventId,
        commissionPercent: commission,
      });
      ApiResponseUtil.created(res, { merchant });
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/merchants/:id { name?, commissionPercent?, isActive? } */
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['id']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return; // ownership failure already answered

      if (typeof req.body.name === 'string' && req.body.name.trim()) merchant.name = req.body.name.trim();
      if (req.body.commissionPercent !== undefined) {
        const c = Number(req.body.commissionPercent);
        if (Number.isFinite(c)) merchant.commissionPercent = Math.min(100, Math.max(0, c));
      }
      if ('isActive' in req.body) merchant.status = req.body.isActive ? 'active' : 'suspended';
      else if (req.body.status === 'active' || req.body.status === 'suspended') merchant.status = req.body.status;
      await merchant.save();
      ApiResponseUtil.success(res, merchant);
    } catch (err) { next(err); }
  }

  /**
   * GET /api/tickets/merchants/:id/transactions — the vendor detail page: the
   * merchant's own record + every charge they collected + running takings.
   * Organizer-scoped via the merchant's event ownership.
   */
  static async transactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['id']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return;
      const rawLimit = Number(req.query['limit']);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const result = await MerchantService.listTransactions({ merchantId: String(merchant._id), limit });
      ApiResponseUtil.success(res, {
        merchant,
        event: { id: String(event._id), name: event.name },
        ...result,
      });
    } catch (err) { next(err); }
  }
}
