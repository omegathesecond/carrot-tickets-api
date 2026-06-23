import { NextFunction, Request, Response } from 'express';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { SettlementService } from '@services/settlement.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';

function parseDate(raw: unknown, fieldName: string, res: Response): Date | null {
  const d = new Date(raw as string);
  if (isNaN(d.getTime())) {
    ApiResponseUtil.badRequest(res, `Invalid date for '${fieldName}'`);
    return null;
  }
  return d;
}

export class ResellerAdminController {
  // ─── Resellers ─────────────────────────────────────────────────────────────

  static async createReseller(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reseller = await Reseller.create(req.body);
      ApiResponseUtil.created(res, reseller);
    } catch (err: any) {
      next(err);
    }
  }

  static async listResellers(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const resellers = await Reseller.find().sort({ createdAt: -1 });
      ApiResponseUtil.success(res, resellers);
    } catch (err: any) {
      next(err);
    }
  }

  static async getReseller(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reseller = await Reseller.findById(req.params['id']);
      if (!reseller) {
        ApiResponseUtil.notFound(res, 'Reseller not found');
        return;
      }
      ApiResponseUtil.success(res, reseller);
    } catch (err: any) {
      next(err);
    }
  }

  static async updateReseller(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const allowed = ['commissionPercent', 'status', 'businessName', 'email', 'phoneNumber', 'isActive'];
      const update: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in req.body) update[key] = req.body[key];
      }
      const reseller = await Reseller.findByIdAndUpdate(
        req.params['id'],
        { $set: update },
        { new: true, runValidators: true },
      );
      if (!reseller) {
        ApiResponseUtil.notFound(res, 'Reseller not found');
        return;
      }
      ApiResponseUtil.success(res, reseller);
    } catch (err: any) {
      next(err);
    }
  }

  // ─── Hubs ───────────────────────────────────────────────────────────────────

  static async createHub(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await ResellerHub.create({ ...req.body, resellerId: req.params['id'] });
      ApiResponseUtil.created(res, hub);
    } catch (err: any) {
      next(err);
    }
  }

  static async listHubs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hubs = await ResellerHub.find({ resellerId: req.params['id'] }).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, hubs);
    } catch (err: any) {
      next(err);
    }
  }

  // ─── Operators ──────────────────────────────────────────────────────────────

  static async createOperator(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await ResellerHub.findById(req.params['hubId']);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      const operator = await ResellerOperator.create({
        fullName: req.body.fullName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        role: req.body.role,
        hubId: hub._id,
        resellerId: hub.resellerId,
        loginCode,
        pin,
      });
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async resetOperatorPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await ResellerOperator.findById(req.params['id']).select('+pin');
      if (!operator) {
        ApiResponseUtil.notFound(res, 'Operator not found');
        return;
      }
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();
      operator.pin = pin;
      operator.failedPinAttempts = 0;
      operator.lockedUntil = null;
      await operator.save();
      ApiResponseUtil.success(res, { operatorId: (operator._id as any).toString(), pin });
    } catch (err: any) {
      next(err);
    }
  }

  static async listOperators(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operators = await ResellerOperator.find({ hubId: req.params['hubId'] }).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, operators);
    } catch (err: any) {
      next(err);
    }
  }

  // ─── Ledger A — Reseller Settlement ─────────────────────────────────────────

  static async previewResellerSettlement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const from = parseDate(req.query['from'], 'from', res);
      if (!from) return;
      const to = parseDate(req.query['to'], 'to', res);
      if (!to) return;

      const result = await SettlementService.previewResellerSettlement(req.params['id']!, from, to);
      ApiResponseUtil.success(res, result);
    } catch (err: any) {
      next(err);
    }
  }

  static async closeResellerSettlement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const from = parseDate(req.body.from, 'from', res);
      if (!from) return;
      const to = parseDate(req.body.to, 'to', res);
      if (!to) return;

      const settlement = await SettlementService.closeResellerSettlement(
        req.params['id']!,
        from,
        to,
        (req as any).ticketsUser.vendorId,
      );
      ApiResponseUtil.created(res, settlement);
    } catch (err: any) {
      next(err);
    }
  }

  static async markResellerSettlementPaid(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const settlement = await SettlementService.markResellerSettlementPaid(
        req.params['sid']!,
        (req as any).ticketsUser.vendorId,
        req.body.paymentReference,
      );
      ApiResponseUtil.success(res, settlement);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('already settled')) {
        ApiResponseUtil.notFound(res, msg);
        return;
      }
      next(err);
    }
  }

  // ─── Ledger B — Organizer Payout ────────────────────────────────────────────

  static async previewOrganizerPayout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const from = parseDate(req.query['from'], 'from', res);
      if (!from) return;
      const to = parseDate(req.query['to'], 'to', res);
      if (!to) return;

      const result = await SettlementService.previewOrganizerPayout(req.params['id']!, from, to);
      ApiResponseUtil.success(res, result);
    } catch (err: any) {
      next(err);
    }
  }

  static async closeOrganizerPayout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const from = parseDate(req.body.from, 'from', res);
      if (!from) return;
      const to = parseDate(req.body.to, 'to', res);
      if (!to) return;

      const payout = await SettlementService.closeOrganizerPayout(
        req.params['id']!,
        from,
        to,
        (req as any).ticketsUser.vendorId,
      );
      ApiResponseUtil.created(res, payout);
    } catch (err: any) {
      next(err);
    }
  }

  static async markOrganizerPayoutPaid(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const payout = await SettlementService.markOrganizerPayoutPaid(
        req.params['pid']!,
        (req as any).ticketsUser.vendorId,
        req.body.paymentReference,
      );
      ApiResponseUtil.success(res, payout);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('already settled')) {
        ApiResponseUtil.notFound(res, msg);
        return;
      }
      next(err);
    }
  }
}
