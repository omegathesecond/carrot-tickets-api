// api/src/controllers/cashierAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { Cashier } from '@models/cashier.model';
import { CashierService } from '@services/cashier.service';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
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
      const cashiers = await Cashier.find(scopeFilter(req)).sort({ createdAt: -1 });
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

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const cashier = await Cashier.create({ fullName: req.body.fullName, phoneNumber: req.body.phoneNumber, scope, vendorId, loginCode, pin });
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
