import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Buyer } from '@models/buyer.model';
import { R2Service } from '@utils/r2.service';
import { normalizePhone } from '@utils/phone.util';

/**
 * Buyer profile endpoints for the public site. A buyer is identified by the
 * verified phone carried on their token (req.ticketsUser.userPhone) — the same
 * identity used by "My Tickets" — so these routes sit behind authenticateBuyer.
 *
 * Only the profile picture is editable here. The name is set at registration;
 * the avatar is stored in the shared tickets R2 bucket (reusing R2Service, the
 * same storage the event media uses) and its public URL is saved on the Buyer.
 */
export class BuyerProfileController {
  /** Resolve the signed-in buyer from the token's verified phone. */
  private static async resolveBuyer(req: Request) {
    const phone = normalizePhone((req as any).ticketsUser?.userPhone || '');
    if (!phone) return { phone: null, buyer: null };
    const buyer = await Buyer.findOne({ phone });
    return { phone, buyer };
  }

  /**
   * GET /api/public/profile
   * Returns the signed-in buyer's public profile (name + avatar). The website
   * uses this to render the profile header; name may be null when the buyer
   * never supplied one at registration.
   */
  static async getProfile(req: Request, res: Response): Promise<any> {
    try {
      const { phone, buyer } = await BuyerProfileController.resolveBuyer(req);
      if (!phone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to view your profile');
      }
      return ApiResponseUtil.success(res, {
        phone,
        name: buyer?.name ?? null,
        avatarUrl: buyer?.avatarUrl ?? null,
      });
    } catch (error: any) {
      console.error('Get buyer profile error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to load profile');
    }
  }

  /**
   * POST /api/public/profile/avatar (multipart 'avatar')
   * Uploads the buyer's profile picture to R2 and saves its public URL. The
   * previous avatar, if any, is deleted best-effort so R2 doesn't accumulate
   * orphaned images.
   */
  static async uploadAvatar(req: Request, res: Response): Promise<any> {
    try {
      const { phone, buyer } = await BuyerProfileController.resolveBuyer(req);
      if (!phone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to update your profile');
      }
      if (!buyer) {
        return ApiResponseUtil.notFound(res, 'Account not found');
      }

      const file = req.file;
      if (!file) {
        return ApiResponseUtil.validationError(res, 'No image uploaded');
      }

      const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const folder = `buyers/${buyer._id}/avatar`;
      const key = R2Service.generateMediaKey(folder, `avatar.${ext}`);
      await R2Service.uploadBufferToR2(key, file.buffer, file.mimetype);
      const url = R2Service.getPublicUrl(key);

      const previous = buyer.avatarUrl;
      buyer.avatarUrl = url;
      await buyer.save();

      if (previous) {
        R2Service.deleteEventMediaByUrl(previous).catch((err) =>
          console.warn('Failed to delete previous avatar (non-fatal):', err?.message),
        );
      }

      return ApiResponseUtil.success(res, { avatarUrl: url }, 'Profile picture updated');
    } catch (error: any) {
      console.error('Upload buyer avatar error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to update profile picture');
    }
  }

  /**
   * DELETE /api/public/profile/avatar
   * Removes the buyer's profile picture (reverts to initials). The stored file
   * is deleted from R2 best-effort.
   */
  static async deleteAvatar(req: Request, res: Response): Promise<any> {
    try {
      const { phone, buyer } = await BuyerProfileController.resolveBuyer(req);
      if (!phone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to update your profile');
      }
      if (!buyer) {
        return ApiResponseUtil.notFound(res, 'Account not found');
      }

      const previous = buyer.avatarUrl;
      await Buyer.updateOne({ _id: buyer._id }, { $unset: { avatarUrl: '' } });

      if (previous) {
        R2Service.deleteEventMediaByUrl(previous).catch((err) =>
          console.warn('Failed to delete avatar from R2 (non-fatal):', err?.message),
        );
      }

      return ApiResponseUtil.success(res, { avatarUrl: null }, 'Profile picture removed');
    } catch (error: any) {
      console.error('Delete buyer avatar error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to remove profile picture');
    }
  }
}
