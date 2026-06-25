// api/src/controllers/gateOperatorAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { GateOperator } from '@models/gateOperator.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';

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
        if (scope === 'organizer' && !vendorId) { ApiResponseUtil.badRequest(res, 'vendorId is required for organizer scope'); return; }
      } else {
        // Non-super-admin is always pinned to their own organizer.
        scope = 'organizer';
        vendorId = actor.vendorId;
        if (!vendorId) { ApiResponseUtil.forbidden(res, 'No organizer scope on token'); return; }
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = generatePin();
      const operator = await GateOperator.create({ fullName: req.body.fullName, phoneNumber: req.body.phoneNumber, scope, vendorId, loginCode, pin });
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await GateOperator.findOne({ _id: req.params['id'], ...scopeFilter(req) }).select('+pin');
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      const pin = generatePin();
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
      if ('isActive' in req.body) operator.isActive = !!req.body.isActive;
      await operator.save();
      ApiResponseUtil.success(res, operator);
    } catch (err) { next(err); }
  }
}
