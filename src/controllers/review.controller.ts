import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { ReviewService } from '@services/review.service';
import { reviewSchema, reviewReplySchema } from '@validators/community.validator';

export class ReviewController {
  /** GET /api/public/events/:eventId/reviews — PUBLIC. */
  static async listForEvent(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId'] || '');
      if (!HEX24.test(eventId)) return ApiResponseUtil.error(res, 'eventId must be an event id', 400);
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      const [aggregate, reviews] = await Promise.all([
        ReviewService.eventAggregate(eventId),
        ReviewService.listEventReviews(eventId, { before: params.before, limit: params.limit }),
      ]);
      return ApiResponseUtil.success(res, { aggregate, reviews });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load reviews');
    }
  }

  /** POST /api/public/events/:eventId/reviews — buyer-auth. */
  static async submit(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await ensureUsername(buyer);

      const { error, value } = reviewSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const review = await ReviewService.submitReview(req.params['eventId'] as string, buyer, value);
      const [view] = await ReviewService.listEventReviews(String(review.eventId), { limit: 1 });
      return ApiResponseUtil.success(res, view, 'Review submitted', 201);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to submit review');
    }
  }

  /** POST /api/tickets/reviews/:reviewId/reply — vendor-auth, own events only. */
  static async reply(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const { error, value } = reviewReplySchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const view = await ReviewService.replyToReview(
        req.params['reviewId'] as string,
        vendorId,
        Boolean(ticketsUser?.isSuperAdmin),
        value.text
      );
      return ApiResponseUtil.success(res, view, 'Reply posted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post reply');
    }
  }
}
