import { Request, Response } from 'express';
import Joi from 'joi';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

// Whitelist every updatable field: the dashboard Settings page sends the full
// config object on each save, so an incomplete schema would reject the whole
// patch on an unlisted key.
const patchSchema = Joi.object({
  keshlessWalletEnabled: Joi.boolean(),
  mtnMomoEnabled: Joi.boolean(),
  cashEnabled: Joi.boolean(),
  cardEnabled: Joi.boolean(),
  defaultResellerCommissionPercent: Joi.number().min(0).max(100),
  platformFeePercent: Joi.number().min(0).max(100),
  // Buyer-paid FLAT service fee (E) per online method.
  keshlessServiceFee: Joi.number().min(0).max(100000),
  momoServiceFee: Joi.number().min(0).max(100000),
  cardServiceFee: Joi.number().min(0).max(100000),
}).min(1);

export class SettingsController {
  static async getPaymentMethods(_req: Request, res: Response): Promise<any> {
    try {
      const cfg = await PaymentConfigService.get();
      return ApiResponseUtil.success(res, cfg);
    } catch (error: any) {
      console.error('Get payment methods config error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch payment method config');
    }
  }

  static async updatePaymentMethods(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = patchSchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.message);
      const cfg = await PaymentConfigService.update(value);
      return ApiResponseUtil.success(res, cfg);
    } catch (error: any) {
      console.error('Update payment methods config error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to update payment method config');
    }
  }
}
