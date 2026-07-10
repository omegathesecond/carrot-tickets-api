import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Follow } from '@models/follow.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername, RESERVED_USERNAMES, USERNAME_REGEX } from '@utils/username.util';
import { toBuyerSummary } from '@utils/buyerSummary.util';
import { updateProfileSchema, blockSchema, followSchema } from '@validators/community.validator';
import { BlockService } from '@services/block.service';
import { FollowService } from '@services/follow.service';
import { NotificationService } from '@services/notification.service';
import { HEX24, failWithHttpError, parseMessageCursorParams } from '@utils/controllerHelpers.util';

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

      const myId = String(buyer._id);
      const [followerCount, followingCount, friendIds, attendedEventIds] = await Promise.all([
        FollowService.followerCount('buyer', myId),
        FollowService.followingCount(myId),
        FollowService.friendIds(myId),
        Ticket.distinct('eventId', { customerPhone: buyer.phone, status: TicketStatus.CHECKED_IN }),
      ]);
      return ApiResponseUtil.success(res, {
        ...SocialProfileController.toOwnProfile(buyer),
        followerCount,
        followingCount,
        friendCount: friendIds.length,
        eventsAttended: attendedEventIds.length,
      });
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

      const viewer = await resolveBuyerFromRequest(req);
      if (!viewer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const viewerId = String(viewer._id);
      const targetId = String(buyer._id);
      const [followerCount, followingCount, attendedEventIds, isFollowing, isFollowedBy, isFriend, isBlocked] =
        await Promise.all([
          FollowService.followerCount('buyer', targetId),
          FollowService.followingCount(targetId),
          Ticket.distinct('eventId', { customerPhone: buyer.phone, status: TicketStatus.CHECKED_IN }),
          Follow.exists({ followerId: viewerId, targetType: 'buyer', targetId }).then(Boolean),
          Follow.exists({ followerId: targetId, targetType: 'buyer', targetId: viewerId }).then(Boolean),
          FollowService.isFriend(viewerId, targetId),
          BlockService.isBlockedEitherWay(viewerId, targetId),
        ]);
      return ApiResponseUtil.success(res, {
        id: targetId,
        username: buyer.username,
        name: buyer.name ?? null,
        avatarUrl: buyer.avatarUrl ?? null,
        bio: buyer.bio ?? null,
        joinedAt: buyer.createdAt,
        followerCount,
        followingCount,
        eventsAttended: attendedEventIds.length,
        isFollowing,
        isFollowedBy,
        isFriend,
        isBlocked,
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
    return failWithHttpError(res, error, fallback);
  }

  /** POST /api/social/follow */
  static async followTarget(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { error, value } = followSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await FollowService.follow(buyer, value.targetType, value.targetId);
      return ApiResponseUtil.success(res, { following: true }, 'Followed');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to follow');
    }
  }

  /** DELETE /api/social/follow/:targetType/:targetId */
  static async unfollowTarget(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const targetType = String(req.params['targetType'] || '');
      const targetId = String(req.params['targetId'] || '');
      if (!['buyer', 'organizer'].includes(targetType) || !/^[0-9a-f]{24}$/i.test(targetId)) {
        return ApiResponseUtil.error(res, 'Invalid follow target', 400);
      }
      await FollowService.unfollow(buyer, targetType as 'buyer' | 'organizer', targetId);
      return ApiResponseUtil.success(res, { following: false }, 'Unfollowed');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to unfollow');
    }
  }

  /** GET /api/social/me/following?type=buyer|organizer (default buyer) */
  static async myFollowing(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const type = req.query['type'] === 'organizer' ? 'organizer' : 'buyer';
      const ids = await FollowService.followingIds(String(buyer._id), type);
      if (type === 'organizer') {
        const vendors = await Vendor.find({ _id: { $in: ids } }).select('businessName slug');
        return ApiResponseUtil.success(res, vendors.map((v: any) => ({
          id: String(v._id), businessName: v.businessName, slug: v.slug ?? null,
        })));
      }
      const buyers = await Buyer.find({ _id: { $in: ids } });
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load following');
    }
  }

  /** GET /api/social/me/followers */
  static async myFollowers(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = await FollowService.followerIds(String(buyer._id));
      const buyers = await Buyer.find({ _id: { $in: ids } });
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load followers');
    }
  }

  /** GET /api/social/me/friends */
  static async myFriends(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = await FollowService.friendIds(String(buyer._id));
      const buyers = await Buyer.find({ _id: { $in: ids } });
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load friends');
    }
  }

  /** GET /api/social/users/search?q= — username prefix; excludes self + blocked either way. */
  static async searchUsers(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const q = String(req.query['q'] || '').toLowerCase();
      if (q.length < 2 || q.length > 20) {
        return ApiResponseUtil.error(res, 'q must be 2-20 characters', 400);
      }
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const myId = String(buyer._id);
      const [iBlocked, blockedMe] = await Promise.all([
        BlockService.listBlockedIds(myId),
        BlockService.listBlockerIds(myId),
      ]);
      const excluded = [myId, ...iBlocked, ...blockedMe];

      const buyers = await Buyer.find({
        username: { $regex: `^${escaped}` },
        _id: { $nin: excluded },
      }).limit(20);
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to search users');
    }
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

  /** GET /api/social/notifications */
  static async myNotifications(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      if (params.after) return ApiResponseUtil.error(res, 'after is not supported for notifications', 400);
      const result = await NotificationService.list(buyer, { before: params.before, limit: params.limit });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load notifications');
    }
  }

  /** POST /api/social/notifications/read { ids?: string[] } */
  static async markNotificationsRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = req.body?.ids;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((i: unknown) => typeof i === 'string' && HEX24.test(i)))) {
        return ApiResponseUtil.error(res, 'ids must be an array of notification ids', 400);
      }
      await NotificationService.markRead(buyer, ids);
      return ApiResponseUtil.success(res, { read: true }, 'Notifications marked read');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to mark notifications read');
    }
  }
}
