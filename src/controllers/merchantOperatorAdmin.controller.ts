// api/src/controllers/merchantOperatorAdmin.controller.ts
import { Request, Response, NextFunction } from 'express';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { generateUniqueLoginCode, generatePin } from '@utils/operatorCredentials.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * Admin CRUD for the people on a stall's till. eventId is always inherited
 * from the stall — a body that supplies one is ignored, so an operator can
 * never be pointed at an event their stall does not belong to.
 */
export class MerchantOperatorAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operators = await MerchantOperator
        .find({ merchantId: req.params['merchantId'] })
        .sort({ createdAt: -1 });
      ApiResponseUtil.success(res, { operators });
    } catch (err) { next(err); }
  }

  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const merchant = await Merchant.findById(req.params['merchantId']);
      if (!merchant) { ApiResponseUtil.notFound(res, 'Stall not found'); return; }

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
      if ('fullName' in req.body) operator.fullName = req.body.fullName;
      if ('isActive' in req.body) operator.isActive = !!req.body.isActive;
      await operator.save();
      ApiResponseUtil.success(res, { operator });
    } catch (err) { next(err); }
  }

  static async resetPin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const operator = await MerchantOperator.findById(req.params['id']).select('+pin');
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
}
