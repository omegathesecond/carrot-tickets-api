import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { ServiceCategoryService } from '@services/serviceCategory.service';

const createServiceCategorySchema = Joi.object({
  value: Joi.string().trim().min(1).max(50).required().messages({
    'string.empty': 'A category value is required',
    'any.required': 'A category value is required',
  }),
  label: Joi.string().trim().min(1).max(100).required().messages({
    'string.empty': 'A category label is required',
    'any.required': 'A category label is required',
  }),
  icon: Joi.string().trim().max(100).optional(),
  order: Joi.number().integer().min(0).optional(),
});

const updateServiceCategorySchema = Joi.object({
  label: Joi.string().trim().min(1).max(100).optional(),
  icon: Joi.string().trim().max(100).optional(),
  order: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

/**
 * Service-categories admin API behind the dashboard category manager —
 * super-admin only (gated in the route, same as /admin/organizers). Backs
 * GET /api/public/service-categories and the DB check
 * ServiceCategoryService.isValidActive applies at SERVICES signup
 * (TicketsAuthService.registerBusiness).
 */
export class AdminServiceCategoriesController {
  /** GET /api/tickets/admin/service-categories — all rows, including inactive. */
  static async list(_req: Request, res: Response): Promise<any> {
    try {
      const categories = await ServiceCategoryService.list();
      return ApiResponseUtil.success(res, { categories });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load service categories');
    }
  }

  /** POST /api/tickets/admin/service-categories */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = createServiceCategorySchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.details[0]?.message || 'Validation error');
      const category = await ServiceCategoryService.create(value);
      return ApiResponseUtil.success(res, { category }, 'Service category created', 201);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create service category');
    }
  }

  /** PATCH /api/tickets/admin/service-categories/:id — value is immutable. */
  static async update(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = updateServiceCategorySchema.validate(req.body);
      if (error) return ApiResponseUtil.badRequest(res, error.details[0]?.message || 'Validation error');
      const category = await ServiceCategoryService.update(req.params['id'] as string, value);
      return ApiResponseUtil.success(res, { category });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update service category');
    }
  }
}
