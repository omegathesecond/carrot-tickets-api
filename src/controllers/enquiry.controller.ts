import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { EnquiryService } from '@services/enquiry.service';

const enquiryCreateSchema = Joi.object({
  message: Joi.string().trim().min(1).max(1000).required(),
  eventDate: Joi.string().isoDate().optional(),
  eventType: Joi.string().trim().max(100).optional(),
  contactPhone: Joi.string().trim().optional(),
  contactEmail: Joi.string().trim().email().optional(),
});

const enquiryStatusSchema = Joi.object({
  status: Joi.string().valid('new', 'read', 'replied', 'closed').required(),
});

export class EnquiryController {
  /** POST /api/public/services/:businessId/enquiries — buyer-auth. */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const businessId = String(req.params['businessId'] || '');
      if (!HEX24.test(businessId)) return ApiResponseUtil.error(res, 'businessId must be a business id', 400);

      const { error, value } = enquiryCreateSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const enquiry = await EnquiryService.create(businessId, buyer, value);
      return ApiResponseUtil.success(res, enquiry, 'Enquiry sent', 201);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to submit enquiry');
    }
  }

  /** GET /api/tickets/services/enquiries — business inbox, MANAGE_ENQUIRIES-gated. */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      if (params.after) return ApiResponseUtil.error(res, 'after is not supported for enquiries', 400);

      const enquiries = await EnquiryService.listForBusiness(vendorId, { before: params.before, limit: params.limit });
      return ApiResponseUtil.success(res, enquiries);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load enquiries');
    }
  }

  /** PATCH /api/tickets/services/enquiries/:id/status — business inbox, MANAGE_ENQUIRIES-gated. */
  static async setStatus(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const id = String(req.params['id'] || '');
      if (!HEX24.test(id)) return ApiResponseUtil.error(res, 'id must be an enquiry id', 400);

      const { error, value } = enquiryStatusSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const updated = await EnquiryService.setStatus(vendorId, id, value.status);
      return ApiResponseUtil.success(res, updated, 'Status updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update enquiry status');
    }
  }
}
