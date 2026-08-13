import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { Vendor } from '@models/vendor.model';
import { AccountKind } from '@interfaces/vendor.interface';
import { BusinessAuthService } from '@services/businessAuth.service';
import { BusinessReviewService } from '@services/businessReview.service';
import {
  businessRequestOtpSchema,
  registerBusinessSchema,
  businessReviewSchema,
  publicBusinessesQuerySchema,
} from '@validators/business.validator';

export class BusinessController {
  /** POST /api/public/businesses/register/request-otp — PUBLIC. */
  static async requestRegistrationOtp(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = businessRequestOtpSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const result = await BusinessAuthService.requestRegistrationOtp(value.identifier);
      return ApiResponseUtil.success(res, result, 'We sent a code to your email or phone');
    } catch (error: any) {
      console.error('Request business registration OTP error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send verification code', 400);
    }
  }

  /** POST /api/public/businesses/register — PUBLIC. */
  static async register(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = registerBusinessSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const result = await BusinessAuthService.registerWithOtp(
        value.identifier,
        value.code,
        value.password,
        value.businessName,
        value.serviceCategory
      );
      return ApiResponseUtil.success(res, result, 'Account created — you are signed in');
    } catch (error: any) {
      console.error('Register business error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to create account', 401);
    }
  }

  /** GET /api/public/businesses — PUBLIC directory: category filter + search + pagination. */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = publicBusinessesQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const { page, limit, search, category } = value;
      const filter: any = { accountKind: AccountKind.BUSINESS, isActive: true };
      if (category && category !== 'All') filter.serviceCategory = category;
      if (search) {
        filter.$or = [
          { businessName: { $regex: search, $options: 'i' } },
          { bio: { $regex: search, $options: 'i' } },
          { 'address.city': { $regex: search, $options: 'i' } },
        ];
      }

      const skip = (page - 1) * limit;
      const [vendors, total] = await Promise.all([
        Vendor.find(filter)
          .select('businessName slug logoUrl bio serviceCategory address isVerified')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Vendor.countDocuments(filter),
      ]);

      const vendorIds = vendors.map((v) => String(v._id));
      const ratings = await Promise.all(vendorIds.map((id) => BusinessReviewService.aggregate(id)));
      const ratingMap = new Map(vendorIds.map((id, i) => [id, ratings[i]]));

      const items = vendors.map((v) => ({
        id: String(v._id),
        businessName: v.businessName,
        slug: (v as any).slug ?? null,
        logoUrl: v.logoUrl ?? null,
        bio: v.bio ?? null,
        serviceCategory: v.serviceCategory ?? null,
        city: v.address?.city ?? null,
        isVerified: v.isVerified,
        rating: ratingMap.get(String(v._id)) ?? { average: null, count: 0 },
      }));

      return ApiResponseUtil.success(res, {
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load businesses');
    }
  }

  /** GET /api/public/businesses/:id — PUBLIC business profile. */
  static async publicProfile(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = String(req.params['id'] || '');
      if (!HEX24.test(vendorId)) return ApiResponseUtil.error(res, 'id must be a business id', 400);

      const vendor = await Vendor.findOne({ _id: vendorId, accountKind: AccountKind.BUSINESS })
        .select('businessName slug logoUrl bio serviceCategory address email phoneNumber isActive isVerified');
      if (!vendor || !vendor.isActive) return ApiResponseUtil.error(res, 'Business not found', 404);

      const rating = await BusinessReviewService.aggregate(vendorId);

      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
        serviceCategory: vendor.serviceCategory ?? null,
        address: vendor.address ?? null,
        email: vendor.email ?? null,
        phoneNumber: vendor.phoneNumber ?? null,
        isVerified: vendor.isVerified,
        rating,
      });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load business profile');
    }
  }

  /** GET /api/public/businesses/:id/reviews — PUBLIC. */
  static async listReviews(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = String(req.params['id'] || '');
      if (!HEX24.test(vendorId)) return ApiResponseUtil.error(res, 'id must be a business id', 400);
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      if (params.after) return ApiResponseUtil.error(res, 'after is not supported for reviews', 400);

      const [aggregate, reviews] = await Promise.all([
        BusinessReviewService.aggregate(vendorId),
        BusinessReviewService.listForBusiness(vendorId, { before: params.before, limit: params.limit }),
      ]);
      return ApiResponseUtil.success(res, { aggregate, reviews });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load reviews');
    }
  }

  /** POST /api/public/businesses/:id/reviews — buyer-auth. */
  static async submitReview(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await ensureUsername(buyer);

      const vendorId = String(req.params['id'] || '');
      if (!HEX24.test(vendorId)) return ApiResponseUtil.error(res, 'id must be a business id', 400);

      const { error, value } = businessReviewSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const review = await BusinessReviewService.submitReview(vendorId, buyer, value);
      const view = await BusinessReviewService.getView(String(review._id));
      return ApiResponseUtil.success(res, view, 'Review submitted', 201);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to submit review');
    }
  }
}
