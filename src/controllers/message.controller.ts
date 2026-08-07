import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { MessageService } from '@services/message.service';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { sendMessageSchema } from '@validators/community.validator';
import { failWithHttpError, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { organizerFromRequest } from '@utils/communityViewer.util';
import { resolveActorFromRequest, type SocialActor } from '@utils/socialActor.util';

export class MessageController {
  private static fail(res: Response, error: any, fallback: string) {
    return failWithHttpError(res, error, fallback);
  }

  /**
   * Resolve the acting identity for a WRITE. A vendor/sub-user token acts as
   * the brand; otherwise the buyer (401s anonymous, ensures a username). Both
   * kinds can post now that Membership is polymorphic.
   */
  private static async requireWriteActor(req: Request, res: Response): Promise<SocialActor | null> {
    const organizer = organizerFromRequest(req);
    if (organizer) return { type: 'vendor', id: organizer.vendorId };
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) {
      ApiResponseUtil.unauthorized(res, 'Please sign in first');
      return null;
    }
    await ensureUsername(buyer);
    return { type: 'buyer', id: String(buyer._id) };
  }

  static async list(req: Request, res: Response): Promise<any> {
    try {
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      const channelId = req.params['channelId'] as string;

      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      // A managing brand that hasn't joined keeps its ownership-gated read-only
      // peek; a member (buyer or a joined brand) reads the membership-gated way.
      const organizer = organizerFromRequest(req);
      if (organizer && !(await MessageService.hasChannelMembership(channelId, actor))) {
        const messages = await MessageService.listMessagesAsOrganizer(channelId, organizer, params);
        return ApiResponseUtil.success(res, messages);
      }

      const messages = await MessageService.listMessages(channelId, actor, params);
      return ApiResponseUtil.success(res, messages);
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to load messages');
    }
  }

  static async send(req: Request, res: Response): Promise<any> {
    try {
      const actor = await MessageController.requireWriteActor(req, res);
      if (!actor) return;

      const { error, value } = sendMessageSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const message = await MessageService.sendMessage(req.params['channelId'] as string, actor, value);
      return ApiResponseUtil.success(res, message, 'Message sent', 201);
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to send message');
    }
  }

  static async deleteOwn(req: Request, res: Response): Promise<any> {
    try {
      const actor = await MessageController.requireWriteActor(req, res);
      if (!actor) return;
      await MessageService.deleteOwnMessage(req.params['messageId'] as string, actor);
      return ApiResponseUtil.success(res, { deleted: true }, 'Message deleted');
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to delete message');
    }
  }

  /** GET /api/community/channels/:channelId/pins — same gating as listing messages. */
  static async listPins(req: Request, res: Response): Promise<any> {
    try {
      const channelId = req.params['channelId'] as string;

      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const organizer = organizerFromRequest(req);
      if (organizer && !(await MessageService.hasChannelMembership(channelId, actor))) {
        const messages = await MessageService.listPinnedMessagesAsOrganizer(channelId, organizer);
        return ApiResponseUtil.success(res, messages);
      }

      const messages = await MessageService.listPinnedMessages(channelId, actor);
      return ApiResponseUtil.success(res, messages);
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to load pinned messages');
    }
  }

  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const actor = await MessageController.requireWriteActor(req, res);
      if (!actor) return;
      await MessageService.markRead(req.params['channelId'] as string, actor);
      return ApiResponseUtil.success(res, { read: true }, 'Channel marked read');
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to mark channel read');
    }
  }
}
