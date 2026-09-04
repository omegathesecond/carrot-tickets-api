// api/src/controllers/merchantOperatorAdmin.controller.ts
import { Request, Response, NextFunction } from 'express';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedEvent } from '@controllers/merchantAdmin.controller';

/**
 * Admin CRUD for the people on a stall's till. eventId is always inherited
 * from the stall — a body that supplies one is ignored, so an operator can
 * never be pointed at an event their stall does not belong to.
 *
 * SECURITY: every handler resolves the operator/stall FIRST (404 if it does
 * not exist) and only then checks event ownership via the shared
 * loadOwnedEvent (403 if it belongs to a different organizer) — mirroring
 * MerchantAdminController, which sits right beside this file and guards the
 * stall itself the same way. Without this, MANAGE_ACCESS (held by every
 * ordinary organizer, not just platform staff) would let any organizer mint
 * or rotate credentials for a stranger's till.
 */
export class MerchantOperatorAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['merchantId']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return; // 404 (event gone) or 403 (different organizer) already answered

      const operators = await MerchantOperator
        .find({ merchantId: merchant._id })
        .sort({ createdAt: -1 });
      ApiResponseUtil.success(res, { operators });
    } catch (err) { next(err); }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['merchantId']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return;

      if (!req.body.fullName || typeof req.body.fullName !== 'string') {
        ApiResponseUtil.badRequest(res, 'fullName is required'); return;
      }

      const loginCode = await generateUniqueLoginCode();
      const pin = typeof req.body.pin === 'string' && /^\d{6}$/.test(req.body.pin)
        ? req.body.pin
        : generatePin();

      const operator = await MerchantOperator.create({
        fullName: req.body.fullName,
        phoneNumber: req.body.phoneNumber,
        merchantId: merchant._id,
        eventId: merchant.eventId,
        loginCode,
        pin,
      });
      // loginCode + pin are returned ONCE here (the pin is never serialized again).
      ApiResponseUtil.created(res, { operator, loginCode, pin });
    } catch (err) { next(err); }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await MerchantOperator.findById(req.params['id']);
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      const merchant = await Merchant.findById(operator.merchantId);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return;

      if ('fullName' in req.body) {
        // Unvalidated, this assignment took whatever arrived: a number renamed
        // the person to "123" (Mongoose casts it), and null threw a
        // ValidationError into next(err) that surfaced as a 500 where a 400
        // belongs. Mirrors the create handler's own fullName check.
        if (typeof req.body.fullName !== 'string' || !req.body.fullName.trim()) {
          ApiResponseUtil.badRequest(res, 'fullName must be a non-empty string'); return;
        }
        operator.fullName = req.body.fullName;
      }
      if ('isActive' in req.body) {
        // `!!` read the STRING "false" as true — a client sending the flag as
        // text re-activated the person it meant to switch off. Only a real
        // boolean lands; anything else is the caller's bug and gets a 400.
        if (typeof req.body.isActive !== 'boolean') {
          ApiResponseUtil.badRequest(res, 'isActive must be a boolean'); return;
        }
        operator.isActive = req.body.isActive;
      }
      await operator.save();
      ApiResponseUtil.success(res, { operator });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await MerchantOperator.findById(req.params['id']).select('+pin');
      if (!operator) { ApiResponseUtil.notFound(res, 'Operator not found'); return; }
      const merchant = await Merchant.findById(operator.merchantId);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }
      const event = await loadOwnedEvent(req, res, String(merchant.eventId));
      if (!event) return;

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
}
