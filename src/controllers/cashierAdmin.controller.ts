// api/src/controllers/cashierAdmin.controller.ts
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { Cashier } from '@models/cashier.model';
import { Event } from '@models/event.model';
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
        // Deliberately NOT rejected here when absent — for organizer scope it
        // is derived from the event further down. Organizer scope still
        // cannot end up vendor-less: it requires an eventId, and the
        // derivation refuses an event that has no organizer.
        vendorId = scope === 'organizer' ? req.body.vendorId : undefined;
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

        // The in-event Cashiers panel sends { fullName, eventId } and has no
        // vendorId to send — the event is the only context it has. Derive the
        // organizer from it, matching MerchantAdminController, which already
        // takes the vendor from the event when creating a stall. Two adjacent
        // admin surfaces disagreeing on this question is exactly the sort of
        // thing that gets rediscovered as a bug later.
        if (!vendorId) {
          const event = mongoose.Types.ObjectId.isValid(String(req.body.eventId))
            ? await Event.findById(req.body.eventId).select('vendorId').lean<{ vendorId?: unknown } | null>()
            : null;
          if (!event) { ApiResponseUtil.badRequest(res, 'Event not found'); return; }
          // A buyer self-listed community event has no owning vendor (see
          // event.model.ts). An organizer-scope cashier with no vendorId
          // would be invisible to every scopeFilter and so unmanageable —
          // refuse rather than create one.
          if (!event.vendorId) { ApiResponseUtil.badRequest(res, 'That event has no organizer to hire a cashier for'); return; }
          vendorId = String(event.vendorId);
        }

        // Validated against the cashier's OWN vendor, not the caller's — a
        // super-admin creating staff for an organizer is still held to that
        // organizer's catalogue. The shared multi-event validator takes an
        // array, so the one event is passed as a one-element one.
        //
        // On the DERIVED path this is now true by construction, which is
        // correct rather than a weakening: the check exists to stop one
        // organizer's staff being pointed at another organizer's show, and
        // taking the vendor FROM the event makes them consistent by
        // definition instead of by assertion. On the EXPLICIT-vendorId path
        // it still does real work.
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
      if ('fullName' in req.body) {
        // Unvalidated, this assignment took whatever arrived: a number renamed
        // the person to "123" (Mongoose casts it), and null threw a
        // ValidationError into next(err) that surfaced as a 500 where a 400
        // belongs. Mirrors the create handler's own fullName check.
        if (typeof req.body.fullName !== 'string' || !req.body.fullName.trim()) {
          ApiResponseUtil.badRequest(res, 'fullName must be a non-empty string'); return;
        }
        cashier.fullName = req.body.fullName;
      }
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
