import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { ServiceCategoryService } from '@services/serviceCategory.service';

/** Public reads of DB-driven service-business categories. */
export class ServiceCategoryController {
  /**
   * GET /api/public/service-categories
   * Active categories for the SERVICES signup form's category picker and
   * the /services directory's category filter.
   */
  static async listActive(_req: Request, res: Response): Promise<any> {
    try {
      const categories = await ServiceCategoryService.listActive();
      return ApiResponseUtil.success(res, { categories });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load service categories');
    }
  }
}
