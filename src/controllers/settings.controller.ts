import { Request, Response } from 'express';
import Joi from 'joi';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

const patchSchema = Joi.object({
  keshlessWalletEnabled: Joi.boolean(),
  mtnMomoEnabled: Joi.boolean(),
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
