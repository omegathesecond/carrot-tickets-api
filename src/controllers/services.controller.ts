import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ServicesService } from '@services/services.service';
import { failWithHttpError } from '@utils/controllerHelpers.util';

export class ServicesController {
  /** GET /api/public/services — services directory (verified vendors only). */
  static async directory(req: Request, res: Response): Promise<any> {
    try {
      const items = await ServicesService.listDirectory({
        category: req.query['category'] ? String(req.query['category']) : undefined,
        search: req.query['search'] ? String(req.query['search']) : undefined,
        before: req.query['before'] ? String(req.query['before']) : undefined,
        limit: req.query['limit'] ? Number(req.query['limit']) : undefined,
      });
      return ApiResponseUtil.success(res, { items }, 'Services');
    } catch (e: any) {
      return failWithHttpError(res, e, 'Failed to list services');
    }
  }

  /** GET /api/public/services/:businessId — single business profile. */
  static async profile(req: Request, res: Response): Promise<any> {
    try {
      const data = await ServicesService.getBusinessProfile(String(req.params['businessId'] || ''));
      return ApiResponseUtil.success(res, data, 'Business profile');
    } catch (e: any) {
      return failWithHttpError(res, e, 'Not found');
    }
  }
}
