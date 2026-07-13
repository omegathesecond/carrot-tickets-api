import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { FollowService } from '@services/follow.service';
import { followSchema } from '@validators/community.validator';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { toBuyerSummary } from '@utils/buyerSummary.util';
import { toVendorSummary } from '@utils/vendorSummary.util';

/** Social-graph endpoints where the acting identity is the organizer brand (Vendor). */
export class VendorSocialController {
  private static vendorId(req: Request): string | undefined {
    return (req as any).ticketsUser?.vendorId;
  }

  /** GET /api/tickets/social/me — the brand's own social summary. */
  static async me(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const vendor = await Vendor.findById(vendorId).select('businessName slug logoUrl bio');
      if (!vendor) return ApiResponseUtil.notFound(res, 'Organizer not found');
      const [followerCount, followingCount] = await Promise.all([
        FollowService.followerCount('organizer', vendorId),
        FollowService.followingCount(vendorId, 'vendor'),
      ]);
      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
        followerCount,
        followingCount,
      });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load brand profile');
    }
  }

  /** POST /api/tickets/social/follow */
  static async follow(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = followSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await FollowService.followAsVendor(vendorId, value.targetType, value.targetId);
      return ApiResponseUtil.success(res, { following: true }, 'Followed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to follow');
    }
  }

  /** DELETE /api/tickets/social/follow/:targetType/:targetId */
  static async unfollow(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const targetType = String(req.params['targetType'] || '');
      const targetId = String(req.params['targetId'] || '');
      if (!['buyer', 'organizer'].includes(targetType) || !/^[0-9a-f]{24}$/i.test(targetId)) {
        return ApiResponseUtil.error(res, 'Invalid follow target', 400);
      }
      await FollowService.unfollowAsVendor(vendorId, targetType as 'buyer' | 'organizer', targetId);
      return ApiResponseUtil.success(res, { following: false }, 'Unfollowed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unfollow');
    }
  }

  /** GET /api/tickets/social/me/following — buyers + brands this brand follows. */
  static async following(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const [buyerIds, orgIds] = await Promise.all([
        FollowService.followingIds(vendorId, 'buyer', 'vendor'),
        FollowService.followingIds(vendorId, 'organizer', 'vendor'),
      ]);
      const [buyers, organizers] = await Promise.all([
        Buyer.find({ _id: { $in: buyerIds } }),
        Vendor.find({ _id: { $in: orgIds } }).select('businessName slug logoUrl'),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: organizers.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load following');
    }
  }

  /** GET /api/tickets/social/me/followers — buyers + brands that follow this brand. */
  static async followers(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const rows = await FollowService.followersOfOrganizer(vendorId);
      const buyerIds = rows.filter((r) => r.followerType === 'buyer').map((r) => r.followerId);
      const vendorIds = rows.filter((r) => r.followerType === 'vendor').map((r) => r.followerId);
      const [buyers, organizers] = await Promise.all([
        Buyer.find({ _id: { $in: buyerIds } }),
        Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl'),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: organizers.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load followers');
    }
  }
}
