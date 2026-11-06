// api/src/controllers/merchantAdmin.controller.ts
import { NextFunction, Request, Response } from 'express';
import { Merchant } from '@models/merchant.model';
import { MerchantService } from '@services/merchant.service';
import { PosCatalogService } from '@services/posCatalog.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getScope, resolveDocScope, scopeOwner } from '@middleware/tradingScope.middleware';
import { scopeIds, scopeMatch } from '@utils/tradingScope.util';

/** A commission percent clamped to 0–100, or undefined when not a number. */
function clampCommission(raw: unknown): number | undefined {
  const c = Number(raw);
  return Number.isFinite(c) ? Math.min(100, Math.max(0, c)) : undefined;
}

/**
 * Stalls (merchants) for ONE scope — an event the caller owns, or the caller's
 * own venue. Routes resolve the scope (eventScope / venueScope); handlers
 * addressed by a stall id check it with resolveDocScope.
 */
export class MerchantAdminController {
  /** The same assigned, active products shown on this stall's POS. */
  static async menu(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findOne({ _id: req.params['id'], deletedAt: null });
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }
      const scope = await resolveDocScope(req, res, merchant, 'Stall not found');
      if (!scope) return;
      const event = (req as any).scopeEvent;
      if (event.currency !== 'ZAR' && event.currency !== 'SZL') throw new Error('Event currency is not configured');
      const products = await PosCatalogService.forMerchant(String(merchant._id), scopeIds(scope));
      ApiResponseUtil.success(res, {
        merchantId: String(merchant._id),
        event: { id: String(event._id), name: event.name, currency: event.currency },
        products,
      });
    } catch (err) { next(err); }
  }

  /** GET /api/tickets/merchants?eventId= | GET /api/tickets/venue/stalls */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchants = await Merchant.find({ ...scopeMatch(scopeIds(getScope(req))), deletedAt: null }).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, merchants);
    } catch (err) { next(err); }
  }

  /** POST /api/tickets/merchants { eventId, name, commissionPercent } | POST /api/tickets/venue/stalls { name } */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = getScope(req);
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        ApiResponseUtil.badRequest(res, 'name is required'); return;
      }
      // A venue pays Carrot off-platform (spec): its stalls never carry a
      // commission, whatever the request says.
      const commissionPercent = scope.kind === 'venue' ? 0 : (clampCommission(req.body.commissionPercent) ?? 0);

      // No credentials are issued here: a stall does not log in. The people
      // who work its till are MerchantOperators, created separately, each
      // with their own loginCode + PIN.
      const merchant = await Merchant.create({ name: name.trim(), ...scopeMatch(scopeIds(scope)), commissionPercent });
      ApiResponseUtil.created(res, { merchant });
    } catch (err) { next(err); }
  }

  /** PATCH /api/tickets/merchants/:id | PATCH /api/tickets/venue/stalls/:id { name?, commissionPercent?, isActive? } */
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findOne({ _id: req.params['id'], deletedAt: null });
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const scope = await resolveDocScope(req, res, merchant, 'Vendor not found');
      if (!scope) return; // already answered

      if ('name' in req.body) {
        if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
          ApiResponseUtil.badRequest(res, 'name must be a non-empty string'); return;
        }
        merchant.name = req.body.name.trim();
      }
      if (scope.kind === 'event' && req.body.commissionPercent !== undefined) {
        const c = Number(req.body.commissionPercent);
        if (!Number.isFinite(c) || c < 0 || c > 100 || req.body.commissionPercent === '' || req.body.commissionPercent === null) {
          ApiResponseUtil.badRequest(res, 'commissionPercent must be between 0 and 100'); return;
        }
        merchant.commissionPercent = c;
      }
      if ('isActive' in req.body) merchant.status = req.body.isActive ? 'active' : 'suspended';
      else if (req.body.status === 'active' || req.body.status === 'suspended') merchant.status = req.body.status;
      await merchant.save();
      ApiResponseUtil.success(res, merchant);
    } catch (err) { next(err); }
  }

  /**
   * GET /api/tickets/merchants/:id/transactions | GET /api/tickets/venue/stalls/:id/transactions
   * The stall detail page: the stall + every charge it collected + running
   * takings, with its owner as `event` or `venue`.
   */
  static async transactions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['id']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Vendor not found'); return; }
      const scope = await resolveDocScope(req, res, merchant, 'Vendor not found');
      if (!scope) return;
      const rawLimit = Number(req.query['limit']);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const result = await MerchantService.listTransactions({ merchantId: String(merchant._id), limit });
      ApiResponseUtil.success(res, { merchant, ...scopeOwner(req), ...result });
    } catch (err) { next(err); }
  }
}
