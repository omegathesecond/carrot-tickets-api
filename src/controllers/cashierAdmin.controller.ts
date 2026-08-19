// api/src/controllers/cashierAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { Cashier } from '@models/cashier.model';
import { CashierService } from '@services/cashier.service';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { validateEventAssignment } from '@services/operatorEventScope.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

/** Cashiers this actor is allowed to see/manage — their own organizer's, or all for platform staff. */
function scopeFilter(req: Request): Record<string, unknown> {
  const actor = actorOf(req);
  if (actor.isSuperAdmin) return {};
  return { scope: 'organizer', vendorId: actor.vendorId };
}

export class CashierAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The dashboard panel lives inside one event, so it scopes to it; the
      // super-admin platform page passes no eventId and still sees the
      // unscoped list.
      const eventId = req.query['eventId'] ? String(req.query['eventId']) : undefined;
      const filter = { ...scopeFilter(req), ...(eventId ? { eventId } : {}) };
      const cashiers = await Cashier.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, cashiers);
    } catch (err) { next(err); }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorOf(req);
      let scope: 'platform' | 'organizer';
      let vendorId: string | undefined;

      if (actor.isSuperAdmin) {
        scope = req.body.scope === 'platform' ? 'platform' : 'organizer';
        vendorId = scope === 'organizer' ? req.body.vendorId : undefined;
        if (scope === 'organizer' && !vendorId) { ApiResponseUtil.badRequest(res, 'vendorId is required for organizer scope'); return; }
      } else {
        // A non-super-admin (an organizer) can only create cashiers for themselves.
        scope = 'organizer';
        vendorId = actor.vendorId;
        if (!vendorId) { ApiResponseUtil.forbidden(res, 'No organizer scope on token'); return; }
      }

      if (!req.body.fullName || typeof req.body.fullName !== 'string') {
        ApiResponseUtil.badRequest(res, 'fullName is required'); return;
      }

      // A cashier is hired for ONE event and ends with it; platform cashiers
      // are Carrot's own staff and are legitimately global, so they take none.
      let eventId: string | undefined;
      if (scope === 'organizer') {
        if (!req.body.eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return; }
        // Validated against the cashier's OWN vendor, not the caller's — a
        // super-admin creating staff for an organizer is still held to that
        // organizer's catalogue. The shared multi-event validator takes an
        // array, so the one event is passed as a one-element one.
        const assignment = await validateEventAssignment([req.body.eventId], vendorId);
        if (!assignment.ok) { ApiResponseUtil.badRequest(res, assignment.message); return; }
        eventId = String(assignment.eventIds[0]);
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const cashier = await Cashier.create({ fullName: req.body.fullName, phoneNumber: req.body.phoneNumber, scope, vendorId, eventId, loginCode, pin });
      // loginCode + pin are returned ONCE here (the pin is never serialized again).
      ApiResponseUtil.created(res, { cashier, loginCode, pin });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cashier = await Cashier.findOne({ _id: req.params['id'], ...scopeFilter(req) }).select('+pin');
      if (!cashier) { ApiResponseUtil.notFound(res, 'Cashier not found'); return; }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      cashier.pin = pin;
      cashier.failedPinAttempts = 0;
      cashier.lockedUntil = null;
      await cashier.save();
      ApiResponseUtil.success(res, { cashierId: (cashier._id as any).toString(), pin });
    } catch (err) { next(err); }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cashier = await Cashier.findOne({ _id: req.params['id'], ...scopeFilter(req) });
      if (!cashier) { ApiResponseUtil.notFound(res, 'Cashier not found'); return; }
      if ('fullName' in req.body) cashier.fullName = req.body.fullName;
      if ('isActive' in req.body) cashier.isActive = !!req.body.isActive;
      // The owning event is deliberately NOT patchable — it is immutable at
      // the schema level, so a body carrying one is ignored. Moving a cashier
      // to another event means hiring a new one for that event.
      await cashier.save();
      ApiResponseUtil.success(res, cashier);
    } catch (err) { next(err); }
  }

  /**
   * GET /api/tickets/cashiers/:id/transactions?eventId= — the cashier detail
   * page: the cashier's record + every top-up/cash-out SHE recorded + running
   * totals. Scoped to the organizer via the same scopeFilter as list/update.
   */
  static async transactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cashier = await Cashier.findOne({ _id: req.params['id'], ...scopeFilter(req) });
      if (!cashier) { ApiResponseUtil.notFound(res, 'Cashier not found'); return; }
      const eventId = req.query['eventId'] ? String(req.query['eventId']) : undefined;
      const rawLimit = Number(req.query['limit']);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const result = await CashierService.listTransactions({ cashierId: String(cashier._id), eventId, limit });
      ApiResponseUtil.success(res, { cashier, ...result });
    } catch (err) { next(err); }
  }
}
