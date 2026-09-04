// api/src/controllers/gateOperatorAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { GateOperator } from '@models/gateOperator.model';
import { Event } from '@models/event.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { validateEventAssignment } from '@services/operatorEventScope.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { sanitizeGrants } from '@interfaces/operatorGrant.interface';
import { GateOperatorActivityService } from '@services/gateOperatorActivity.service';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

/** Operators this actor is allowed to see/manage. */
function scopeFilter(req: Request): Record<string, unknown> {
  const actor = actorOf(req);
  if (actor.isSuperAdmin) return {};
  return { scope: 'organizer', vendorId: actor.vendorId };
}

export class GateOperatorAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operators = await GateOperator.find(scopeFilter(req)).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, operators);
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

        // The in-event Register panel sends { fullName, eventIds:[id], grants }
        // and has no vendorId to send — the event is the only context it has.
        // Derive the organizer from it, matching CashierAdminController and
        // MerchantAdminController, which already take the vendor from the event
        // when hiring a cashier or creating a stall. This surface refusing
        // while its two neighbours derive is what put "vendorId is required for
        // organizer scope" in front of an admin adding a register desk.
        //
        // Only the FIRST event is read: validateEventAssignment below then
        // holds every id in the list to the vendor taken from it, so a mixed
        // list is refused rather than silently split across organizers.
        const eventIds: unknown[] = Array.isArray(req.body.eventIds) ? req.body.eventIds : [];
        if (scope === 'organizer' && !vendorId && eventIds.length > 0) {
          const first = String(eventIds[0]);
          const event = mongoose.Types.ObjectId.isValid(first)
            ? await Event.findById(first).select('vendorId').lean<{ vendorId?: unknown } | null>()
            : null;
          if (!event) { ApiResponseUtil.badRequest(res, 'Event not found'); return; }
          // A buyer self-listed community event has no owning vendor (see
          // event.model.ts). An organizer-scope row with no vendorId is
          // invisible to every scopeFilter above and so unmanageable — refuse
          // rather than create one.
          if (!event.vendorId) { ApiResponseUtil.badRequest(res, 'That event has no organizer to add a register account for'); return; }
          vendorId = String(event.vendorId);
        }

        // Nothing named the organizer and there was no event to read it from.
        if (scope === 'organizer' && !vendorId) { ApiResponseUtil.badRequest(res, 'vendorId is required for organizer scope'); return; }
      } else {
        // Non-super-admin is always pinned to their own organizer.
        scope = 'organizer';
        vendorId = actor.vendorId;
        if (!vendorId) { ApiResponseUtil.forbidden(res, 'No organizer scope on token'); return; }
      }

      // Validated against the operator's OWN vendor, so a super-admin creating
      // on an organizer's behalf still cannot reach past that organizer.
      const assignment = await validateEventAssignment(req.body.eventIds ?? [], vendorId);
      if (!assignment.ok) { ApiResponseUtil.badRequest(res, assignment.message); return; }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const operator = await GateOperator.create({ fullName: req.body.fullName, phoneNumber: req.body.phoneNumber, scope, vendorId, eventIds: assignment.eventIds, loginCode, pin, grants: sanitizeGrants(req.body.grants) });
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err) { next(err); }
  }

  /**
   * GET /api/tickets/gate-operators/:id/activity?eventId=&limit=
   *
   * What this person actually did on the door — scans taken, how many were
   * admitted vs turned away, and the tags they registered. Scoped through the
   * same filter as every other route here, so an organizer can only ever read
   * their own operators.
   */
  static async activity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await GateOperator.findOne({ _id: req.params['id'], ...scopeFilter(req) });
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      const eventId = req.query['eventId'] ? String(req.query['eventId']) : undefined;
      const rawLimit = Number(req.query['limit']);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const operatorId = String(operator._id);
      const [activity, registrations] = await Promise.all([
        GateOperatorActivityService.forOperator({ operatorId, ...(eventId ? { eventId } : {}), limit }),
        GateOperatorActivityService.registrationsBy({ operatorId, ...(eventId ? { eventId } : {}), limit }),
      ]);
      ApiResponseUtil.success(res, { operator, ...activity, registrations });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await GateOperator.findOne({ _id: req.params['id'], ...scopeFilter(req) }).select('+pin');
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      operator.pin = pin;
      operator.failedPinAttempts = 0;
      operator.lockedUntil = null;
      await operator.save();
      ApiResponseUtil.success(res, { operatorId: (operator._id as any).toString(), pin });
    } catch (err) { next(err); }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await GateOperator.findOne({ _id: req.params['id'], ...scopeFilter(req) });
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      if ('fullName' in req.body) operator.fullName = req.body.fullName;
      if ('isActive' in req.body) {
        // `!!` read the STRING "false" as true — a client sending the flag as
        // text re-activated the person it meant to switch off. Only a real
        // boolean lands; anything else is the caller's bug and gets a 400.
        if (typeof req.body.isActive !== 'boolean') {
          ApiResponseUtil.badRequest(res, 'isActive must be a boolean'); return;
        }
        operator.isActive = req.body.isActive;
      }
      // Unknown values are dropped rather than rejected: the list is a set of
      // capabilities, and a client sending one this version doesn't know about
      // must not be able to write it through to the token.
      if ('grants' in req.body) (operator as any).grants = sanitizeGrants(req.body.grants);
      if ('eventIds' in req.body) {
        const assignment = await validateEventAssignment(req.body.eventIds, operator.vendorId?.toString());
        if (!assignment.ok) { ApiResponseUtil.badRequest(res, assignment.message); return; }
        operator.eventIds = assignment.eventIds as any;
      }
      await operator.save();
      ApiResponseUtil.success(res, operator);
    } catch (err) { next(err); }
  }
}
