import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { Event } from '@models/event.model';
import { Community } from '@models/community.model';
import { Message, IMessage } from '@models/message.model';
import { Membership } from '@models/membership.model';
import { ModerationService } from '@services/moderation.service';
import { muteSchema } from '@validators/community.validator';

const OWNERSHIP_ERROR = 'You can only moderate your own events';

export class ModerationController {
  /**
   * Community -> event -> vendorId ownership walk, shared by every handler
   * below (mirrors ChannelAdminController.update's walk). Writes the 404/403
   * response itself and returns null on failure so callers can `if (!ok) return;`.
   */
  private static async requireCommunityOwnership(
    communityId: string,
    ticketsUser: any,
    res: Response
  ): Promise<boolean> {
    const community = await Community.findById(communityId).select('eventId');
    if (!community) {
      ApiResponseUtil.error(res, 'Community not found', 404);
      return false;
    }
    const event = await Event.findById(community.eventId).select('vendorId');
    if (!event) {
      ApiResponseUtil.error(res, 'Event not found', 404);
      return false;
    }
    if (!ticketsUser?.isSuperAdmin && String(event.vendorId) !== String(ticketsUser?.vendorId)) {
      ApiResponseUtil.error(res, OWNERSHIP_ERROR, 403);
      return false;
    }
    return true;
  }

  /**
   * messageId -> owned CHANNEL message (community/event ownership already
   * verified). DM messages 404 here (organizers never touch DMs) — the
   * message carries communityId directly, so no channel load is needed,
   * same optimization as MessageService.deleteOwnMessage.
   */
  private static async requireOwnedChannelMessage(
    messageId: string,
    ticketsUser: any,
    res: Response
  ): Promise<IMessage | null> {
    if (!HEX24.test(messageId)) {
      ApiResponseUtil.error(res, 'messageId must be a message id', 400);
      return null;
    }
    const message = await Message.findById(messageId);
    if (!message || !message.channelId) {
      ApiResponseUtil.error(res, 'Message not found', 404);
      return null;
    }
    const owned = await ModerationController.requireCommunityOwnership(
      String(message.communityId),
      ticketsUser,
      res
    );
    if (!owned) return null;
    return message;
  }

  /** DELETE /api/tickets/messages/:messageId — delete ANY channel message. */
  static async deleteMessage(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const messageId = String(req.params['messageId'] || '');
      const message = await ModerationController.requireOwnedChannelMessage(messageId, ticketsUser, res);
      if (!message) return;
      if (message.deletedAt) return ApiResponseUtil.error(res, 'Message not found', 404);

      await ModerationService.deleteMessage(message);
      return ApiResponseUtil.success(res, { deleted: true }, 'Message deleted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to delete message');
    }
  }

  /** POST /api/tickets/messages/:messageId/pin */
  static async pin(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const messageId = String(req.params['messageId'] || '');
      const message = await ModerationController.requireOwnedChannelMessage(messageId, ticketsUser, res);
      if (!message) return;
      if (message.deletedAt) return ApiResponseUtil.error(res, 'Message not found', 404);

      await ModerationService.pinMessage(message);
      return ApiResponseUtil.success(res, { pinned: true }, 'Message pinned');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to pin message');
    }
  }

  /** DELETE /api/tickets/messages/:messageId/pin */
  static async unpin(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const messageId = String(req.params['messageId'] || '');
      const message = await ModerationController.requireOwnedChannelMessage(messageId, ticketsUser, res);
      if (!message) return;

      await ModerationService.unpinMessage(message);
      return ApiResponseUtil.success(res, { pinned: false }, 'Message unpinned');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unpin message');
    }
  }

  /**
   * buyerId -> owned Membership row for :communityId (community/event
   * ownership already verified). 404 when there's no membership at all.
   */
  private static async requireOwnedMembership(
    communityId: string,
    buyerId: string,
    ticketsUser: any,
    res: Response
  ) {
    if (!HEX24.test(communityId) || !HEX24.test(buyerId)) {
      ApiResponseUtil.error(res, 'communityId and buyerId must be valid ids', 400);
      return null;
    }
    const owned = await ModerationController.requireCommunityOwnership(communityId, ticketsUser, res);
    if (!owned) return null;

    const membership = await Membership.findOne({ communityId, buyerId });
    if (!membership) {
      ApiResponseUtil.error(res, 'Membership not found', 404);
      return null;
    }
    return membership;
  }

  /** POST /api/tickets/communities/:communityId/members/:buyerId/mute */
  static async mute(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const { error, value } = muteSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const membership = await ModerationController.requireOwnedMembership(
        String(req.params['communityId'] || ''),
        String(req.params['buyerId'] || ''),
        ticketsUser,
        res
      );
      if (!membership) return;

      const mutedUntil = await ModerationService.mute(membership, value.minutes);
      return ApiResponseUtil.success(res, { mutedUntil }, 'Member muted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mute member');
    }
  }

  /** DELETE /api/tickets/communities/:communityId/members/:buyerId/mute */
  static async unmute(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const membership = await ModerationController.requireOwnedMembership(
        String(req.params['communityId'] || ''),
        String(req.params['buyerId'] || ''),
        ticketsUser,
        res
      );
      if (!membership) return;

      await ModerationService.unmute(membership);
      return ApiResponseUtil.success(res, { mutedUntil: null }, 'Member unmuted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unmute member');
    }
  }

  /** POST /api/tickets/communities/:communityId/members/:buyerId/ban */
  static async ban(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const membership = await ModerationController.requireOwnedMembership(
        String(req.params['communityId'] || ''),
        String(req.params['buyerId'] || ''),
        ticketsUser,
        res
      );
      if (!membership) return;

      await ModerationService.ban(membership);
      return ApiResponseUtil.success(res, { banned: true }, 'Member banned');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to ban member');
    }
  }

  /** DELETE /api/tickets/communities/:communityId/members/:buyerId/ban */
  static async unban(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const membership = await ModerationController.requireOwnedMembership(
        String(req.params['communityId'] || ''),
        String(req.params['buyerId'] || ''),
        ticketsUser,
        res
      );
      if (!membership) return;

      await ModerationService.unban(membership);
      return ApiResponseUtil.success(res, { banned: false }, 'Member unbanned');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unban member');
    }
  }

  /** GET /api/tickets/communities/:communityId/members?before&limit — admin roster. */
  static async listMembers(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      if (!ticketsUser?.vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const communityId = String(req.params['communityId'] || '');
      if (!HEX24.test(communityId)) return ApiResponseUtil.error(res, 'communityId must be a community id', 400);

      const owned = await ModerationController.requireCommunityOwnership(communityId, ticketsUser, res);
      if (!owned) return;

      const limitRaw = req.query['limit'];
      let limit = 25;
      if (limitRaw !== undefined) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1) {
          return ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
        }
        limit = Math.min(limit, 50);
      }
      const before = req.query['before'] as string | undefined;
      if (before !== undefined && !HEX24.test(before)) {
        return ApiResponseUtil.error(res, 'before must be a member cursor', 400);
      }

      const members = await ModerationService.listMembers(communityId, { before, limit });
      return ApiResponseUtil.success(res, members);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load members');
    }
  }
}
