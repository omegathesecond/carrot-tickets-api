import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Buyer, IBuyer } from '@models/buyer.model';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername, RESERVED_USERNAMES, USERNAME_REGEX } from '@utils/username.util';
import { updateProfileSchema, blockSchema } from '@validators/community.validator';
import { BlockService } from '@services/block.service';
import { HttpError } from '@utils/httpError.util';

export class SocialProfileController {
  /** Own-profile payload. NEVER include the phone — usernames are the public identity. */
  private static toOwnProfile(buyer: IBuyer) {
    return {
      id: String(buyer._id),
      username: buyer.username ?? null,
      usernameCustomized: Boolean(buyer.usernameCustomizedAt),
      name: buyer.name ?? null,
      avatarUrl: buyer.avatarUrl ?? null,
      bio: buyer.bio ?? null,
      dmPrivacy: buyer.dmPrivacy,
    };
  }

  /** GET /api/social/me */
  static async me(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await ensureUsername(buyer);
      return ApiResponseUtil.success(res, SocialProfileController.toOwnProfile(buyer));
    } catch (error: any) {
      console.error('Get social profile error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to load profile', 500);
    }
  }

  /** PATCH /api/social/me — username / bio / dmPrivacy. */
  static async update(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      if (value.username !== undefined) {
        const username = String(value.username).toLowerCase();
        if (!USERNAME_REGEX.test(username)) {
          return ApiResponseUtil.error(res, 'Usernames are 3-20 characters: a-z, 0-9 and _', 400);
        }
        if (RESERVED_USERNAMES.includes(username)) {
          return ApiResponseUtil.error(res, 'That username is reserved', 409);
        }
        buyer.username = username;
        buyer.usernameCustomizedAt = new Date();
      }
      if (value.bio !== undefined) buyer.bio = value.bio;
      if (value.dmPrivacy !== undefined) buyer.dmPrivacy = value.dmPrivacy;

      try {
        await buyer.save();
      } catch (err: any) {
        if (err?.code === 11000) return ApiResponseUtil.error(res, 'That username is taken', 409);
        throw err;
      }
      return ApiResponseUtil.success(res, SocialProfileController.toOwnProfile(buyer), 'Profile updated');
    } catch (error: any) {
      console.error('Update social profile error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to update profile', 500);
    }
  }

  /** GET /api/social/users/:username — public profile. NEVER exposes phone or privacy settings. */
  static async publicProfile(req: Request, res: Response): Promise<any> {
    try {
      const username = String(req.params['username'] || '').toLowerCase();
      const buyer = await Buyer.findOne({ username });
      if (!buyer) return ApiResponseUtil.error(res, 'User not found', 404);
      return ApiResponseUtil.success(res, {
        id: String(buyer._id),
        username: buyer.username,
        name: buyer.name ?? null,
        avatarUrl: buyer.avatarUrl ?? null,
        bio: buyer.bio ?? null,
        joinedAt: buyer.createdAt,
      });
    } catch (error: any) {
      console.error('Get public profile error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to load profile', 500);
    }
  }

  /** GET /api/social/username-available?u=<candidate> */
  static async usernameAvailable(req: Request, res: Response): Promise<any> {
    try {
      const candidate = String(req.query['u'] || '').toLowerCase();
      if (!USERNAME_REGEX.test(candidate) || RESERVED_USERNAMES.includes(candidate)) {
        return ApiResponseUtil.success(res, { available: false });
      }
      const taken = await Buyer.exists({ username: candidate });
      return ApiResponseUtil.success(res, { available: !taken });
    } catch (error: any) {
      console.error('Username availability error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to check username', 500);
    }
  }

  private static failSocial(res: Response, error: any, fallback: string) {
    if (error instanceof HttpError) return ApiResponseUtil.error(res, error.message, error.statusCode);
    console.error(fallback, error);
    return ApiResponseUtil.error(res, error?.message || fallback, 500);
  }

  /** POST /api/social/block */
  static async blockUser(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { error, value } = blockSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await BlockService.block(buyer, value.userId);
      return ApiResponseUtil.success(res, { blocked: true }, 'User blocked');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to block user');
    }
  }

  /** DELETE /api/social/block/:userId */
  static async unblockUser(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const userId = String(req.params['userId'] || '');
      if (!/^[0-9a-f]{24}$/i.test(userId)) return ApiResponseUtil.error(res, 'userId must be a user id', 400);
      await BlockService.unblock(buyer, userId);
      return ApiResponseUtil.success(res, { blocked: false }, 'User unblocked');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to unblock user');
    }
  }

  /** GET /api/social/me/blocks — feeds client-side hiding of channel messages. */
  static async myBlocks(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const userIds = await BlockService.listBlockedIds(String(buyer._id));
      return ApiResponseUtil.success(res, { userIds });
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load blocks');
    }
  }
}
