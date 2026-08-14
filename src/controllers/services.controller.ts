import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ServicesService } from '@services/services.service';
import { ReviewService } from '@services/review.service';
import { failWithHttpError, HEX24, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { reviewSchema } from '@validators/community.validator';

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

  /** GET /api/public/services/:businessId/reviews — PUBLIC. */
  static async listReviews(req: Request, res: Response): Promise<any> {
    try {
      const businessId = String(req.params['businessId'] || '');
      if (!HEX24.test(businessId)) return ApiResponseUtil.error(res, 'businessId must be a business id', 400);
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      if (params.after) return ApiResponseUtil.error(res, 'after is not supported for reviews', 400);
      const reviews = await ReviewService.listBusinessReviews(businessId, { before: params.before, limit: params.limit });
      return ApiResponseUtil.success(res, { reviews }, 'Reviews');
    } catch (e: any) {
      return failWithHttpError(res, e, 'Failed to load reviews');
    }
  }

  /** POST /api/public/services/:businessId/reviews — buyer-auth, enquiry-gated. */
  static async submitReview(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const businessId = String(req.params['businessId'] || '');
      if (!HEX24.test(businessId)) return ApiResponseUtil.error(res, 'businessId must be a business id', 400);

      const { error, value } = reviewSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const review = await ReviewService.submitServiceReview(businessId, buyer, value);
      // By id — a "latest for business" read could echo a concurrent buyer's review.
      const view = await ReviewService.getView(String(review._id));
      return ApiResponseUtil.success(res, view, 'Review submitted', 201);
    } catch (e: any) {
      return failWithHttpError(res, e, 'Failed to submit review');
    }
  }
}
