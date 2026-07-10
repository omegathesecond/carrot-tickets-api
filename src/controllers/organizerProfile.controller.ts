import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { Vendor } from '@models/vendor.model';
import { organizerProfileSchema } from '@validators/community.validator';

export class OrganizerProfileController {
  /** PATCH /api/tickets/organizer/profile — vendor updates its own brand card. */
  static async updateOwn(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const { error, value } = organizerProfileSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const vendor = await Vendor.findById(vendorId);
      if (!vendor) return ApiResponseUtil.error(res, 'Organizer not found', 404);
      if (value.logoUrl !== undefined) vendor.logoUrl = value.logoUrl;
      if (value.bio !== undefined) vendor.bio = value.bio;
      await vendor.save();

      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
      }, 'Profile updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update organizer profile');
    }
  }
}
