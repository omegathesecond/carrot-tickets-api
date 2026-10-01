import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import {
  VenueService,
  VenueAlreadyExistsError,
  VenueVendorNotFoundError,
  VenueNotFoundError,
  toVenueSummary,
} from '@services/venue.service';

const activateSchema = Joi.object({
  vendorId: Joi.string().hex().length(24).required(),
  name: Joi.string().trim().min(1).max(120).required(),
  currency: Joi.string().valid('SZL', 'ZAR').required(),
});

const statusSchema = Joi.object({
  status: Joi.string().valid('active', 'suspended').required(),
});

/**
 * Venue trading switch (venue trading spec, Phase 1). Super-admin only (gated
 * in the route). Switching on is the commercial gate — Carrot bills venues
 * off-platform — so there is no vendor-side path to create a Venue.
 */
export class AdminVenuesController {
  /** POST /api/tickets/admin/venues { vendorId, name, currency } */
  static async activate(req: Request, res: Response): Promise<any> {
    const { error, value } = activateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const venue = await VenueService.activate({
        ...value,
        activatedBy: String((req as any).ticketsUser.vendorId),
      });
      return ApiResponseUtil.success(res, toVenueSummary(venue), 'Venue trading switched on', 201);
    } catch (e: any) {
      if (e instanceof VenueAlreadyExistsError) return ApiResponseUtil.error(res, e.message, 409);
      if (e instanceof VenueVendorNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      console.error('Activate venue error:', e);
      return ApiResponseUtil.error(res, e.message || 'Failed to switch venue trading on', 500);
    }
  }

  /** PATCH /api/tickets/admin/venues/:id { status: 'active' | 'suspended' } */
  static async updateStatus(req: Request, res: Response): Promise<any> {
    const { error, value } = statusSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const venue = await VenueService.setStatus(String(req.params['id']), value.status);
      return ApiResponseUtil.success(res, toVenueSummary(venue));
    } catch (e: any) {
      if (e instanceof VenueNotFoundError) return ApiResponseUtil.notFound(res, e.message);
      console.error('Update venue status error:', e);
      return ApiResponseUtil.error(res, e.message || 'Failed to update venue', 500);
    }
  }
}
