// api/src/controllers/waiterAdmin.controller.ts
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { Waiter } from '@models/waiter.model';
import { Event } from '@models/event.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { validateEventAssignment } from '@services/operatorEventScope.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { OperatorGrant, sanitizeGrants } from '@interfaces/operatorGrant.interface';
import { TradingScope } from '@utils/tradingScope.util';
import { HEX24 } from '@utils/controllerHelpers.util';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

/** The venue a `/venue/waiters` route resolved (venueScope), or null on the event routes. */
function venueIdOf(req: Request): string | null {
  const scope = (req as any).tradingScope as TradingScope | undefined;
  return scope?.kind === 'venue' ? scope.venueId : null;
}

/**
 * Waiters this request may see/manage. On a venue route: that venue's
 * (venueScope already tied it to the caller's vendor). On the event routes:
 * the caller's own organizer's — or all for platform staff — and NEVER a
 * venue's (`venueId: null` also matches "no venueId").
 */
function scopeFilter(req: Request): Record<string, unknown> {
  const venueId = venueIdOf(req);
  if (venueId) return { venueId };
  const actor = actorOf(req);
  return { ...(actor.isSuperAdmin ? {} : { scope: 'organizer', vendorId: actor.vendorId }), venueId: null };
}

/**
 * On a venue route a junk id is "no such waiter", not a cast error. Answers 404
 * and returns true; the event routes keep their existing behaviour for one.
 */
function junkVenueWaiterId(req: Request, res: Response): boolean {
  if (venueIdOf(req) && !HEX24.test(String(req.params['id']))) {
    ApiResponseUtil.notFound(res, 'Waiter not found');
    return true;
  }
  return false;
}

/** Answers 400 and returns false when the body carries no usable fullName. */
function hasFullName(req: Request, res: Response): boolean {
  if (!req.body.fullName || typeof req.body.fullName !== 'string') {
    ApiResponseUtil.badRequest(res, 'fullName is required');
    return false;
  }
  return true;
}

export class WaiterAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The dashboard panel lives inside one event, so it scopes to it; the
      // super-admin platform page passes no eventId and still sees the
      // unscoped list. A venue list takes no eventId.
      const eventId = !venueIdOf(req) && req.query['eventId'] ? String(req.query['eventId']) : undefined;
      const filter = { deletedAt: null, ...scopeFilter(req), ...(eventId ? { eventId } : {}) };
      const waiters = await Waiter.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, waiters);
    } catch (err) { next(err); }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const venueId = venueIdOf(req);
      let owner: { scope: 'platform' | 'organizer'; vendorId?: string; eventId?: string; venueId?: string };
      if (venueId) {
        if (!hasFullName(req, res)) return;
        // A venue's waiter belongs to the venue's vendor; there is no event to check.
        owner = { scope: 'organizer', vendorId: String((req as any).scopeVenue.vendorId), venueId };
      } else {
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
          // A non-super-admin (an organizer) can only create waiters for themselves.
          scope = 'organizer';
          vendorId = actor.vendorId;
          if (!vendorId) { ApiResponseUtil.forbidden(res, 'No organizer scope on token'); return; }
        }

        if (!hasFullName(req, res)) return;

        // A waiter is hired for ONE event (or, at a venue, ONE venue) and ends
        // with it; platform waiters are Carrot's own staff and are legitimately
        // global, so they take none.
        let eventId: string | undefined;
        if (scope === 'organizer') {
          if (!req.body.eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return; }

          // The in-event Waiters panel sends { fullName, eventId } and has no
          // vendorId to send — the event is the only context it has. Derive the
          // organizer from it, matching CashierAdminController and
          // MerchantAdminController, which already take the vendor from the
          // event when creating their own operator. Three adjacent admin
          // surfaces disagreeing on this question is exactly the sort of thing
          // that gets rediscovered as a bug later.
          if (!vendorId) {
            const event = mongoose.Types.ObjectId.isValid(String(req.body.eventId))
              ? await Event.findById(req.body.eventId).select('vendorId').lean<{ vendorId?: unknown } | null>()
              : null;
            if (!event) { ApiResponseUtil.badRequest(res, 'Event not found'); return; }
            // A buyer self-listed community event has no owning vendor (see
            // event.model.ts). An organizer-scope waiter with no vendorId
            // would be invisible to every scopeFilter and so unmanageable —
            // refuse rather than create one.
            if (!event.vendorId) { ApiResponseUtil.badRequest(res, 'That event has no organizer to hire a waiter for'); return; }
            vendorId = String(event.vendorId);
          }

          // Validated against the waiter's OWN vendor, not the caller's — a
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
        owner = { scope, vendorId, eventId };
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const waiter = await Waiter.create({
        fullName: req.body.fullName, phoneNumber: req.body.phoneNumber, ...owner, loginCode, pin,
        // At a venue the waiter who served is the one who takes the money
        // (spec: Decisions), so taking payment is on unless the caller says otherwise.
        grants: req.body.grants === undefined ? [OperatorGrant.SETTLE_TABLES] : sanitizeGrants(req.body.grants),
      });
      // loginCode + pin are returned ONCE here (the pin is never serialized again).
      ApiResponseUtil.created(res, { waiter, loginCode, pin });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (junkVenueWaiterId(req, res)) return;
      const waiter = await Waiter.findOne({ _id: req.params['id'], deletedAt: null, ...scopeFilter(req) }).select('+pin');
      if (!waiter) { ApiResponseUtil.notFound(res, 'Waiter not found'); return; }
      if ('grants' in req.body) (waiter as any).grants = sanitizeGrants(req.body.grants);
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      waiter.pin = pin;
      waiter.failedPinAttempts = 0;
      waiter.lockedUntil = null;
      await waiter.save();
      ApiResponseUtil.success(res, { waiterId: (waiter._id as any).toString(), pin });
    } catch (err) { next(err); }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (junkVenueWaiterId(req, res)) return;
      const waiter = await Waiter.findOne({ _id: req.params['id'], deletedAt: null, ...scopeFilter(req) });
      if (!waiter) { ApiResponseUtil.notFound(res, 'Waiter not found'); return; }
      if ('fullName' in req.body) {
        // Unvalidated, this assignment took whatever arrived: a number renamed
        // the person to "123" (Mongoose casts it), and null threw a
        // ValidationError into next(err) that surfaced as a 500 where a 400
        // belongs. Mirrors the create handler's own fullName check.
        if (typeof req.body.fullName !== 'string' || !req.body.fullName.trim()) {
          ApiResponseUtil.badRequest(res, 'fullName must be a non-empty string'); return;
        }
        waiter.fullName = req.body.fullName;
      }
      if ('phoneNumber' in req.body) {
        if (typeof req.body.phoneNumber !== 'string') {
          ApiResponseUtil.badRequest(res, 'phoneNumber must be a string'); return;
        }
        waiter.phoneNumber = req.body.phoneNumber.trim() || undefined;
      }
      if ('isActive' in req.body) {
        // `!!` read the STRING "false" as true — a client sending the flag as
        // text re-activated the person it meant to switch off. Only a real
        // boolean lands; anything else is the caller's bug and gets a 400.
        if (typeof req.body.isActive !== 'boolean') {
          ApiResponseUtil.badRequest(res, 'isActive must be a boolean'); return;
        }
        waiter.isActive = req.body.isActive;
      }
      if ('grants' in req.body) {
        // settle_tables is the money moment — the organizer may want it held
        // by a supervisor rather than every waiter, so at an event it is only
        // settable per person, not at hire time by default (a venue's waiter
        // takes payment from the start, see create). sanitizeGrants drops
        // anything that is not a real capability rather than storing it,
        // same as create.
        waiter.grants = sanitizeGrants(req.body.grants);
      }
      // The owning event or venue is deliberately NOT patchable — both are
      // immutable at the schema level, so a body carrying one is ignored.
      // Moving a waiter to another event or venue means hiring a new one.
      await waiter.save();
      ApiResponseUtil.success(res, waiter);
    } catch (err) { next(err); }
  }
}
