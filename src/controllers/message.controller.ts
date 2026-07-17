import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { MessageService } from '@services/message.service';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { sendMessageSchema } from '@validators/community.validator';
import { failWithHttpError, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { organizerFromRequest } from '@utils/communityViewer.util';

export class MessageController {
  private static fail(res: Response, error: any, fallback: string) {
    return failWithHttpError(res, error, fallback);
  }

  static async list(req: Request, res: Response): Promise<any> {
    try {
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      const channelId = req.params['channelId'] as string;

      // Organizer read-only peek is ownership-gated; buyer read is membership-gated.
      const organizer = organizerFromRequest(req);
      if (organizer) {
        const messages = await MessageService.listMessagesAsOrganizer(channelId, organizer, params);
        return ApiResponseUtil.success(res, messages);
      }

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const messages = await MessageService.listMessages(channelId, buyer, params);
      return ApiResponseUtil.success(res, messages);
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to load messages');
    }
  }

  static async send(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await ensureUsername(buyer);

      const { error, value } = sendMessageSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const message = await MessageService.sendMessage(req.params['channelId'] as string, buyer, value);
      return ApiResponseUtil.success(res, message, 'Message sent', 201);
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to send message');
    }
  }

  static async deleteOwn(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await MessageService.deleteOwnMessage(req.params['messageId'] as string, buyer);
      return ApiResponseUtil.success(res, { deleted: true }, 'Message deleted');
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to delete message');
    }
  }

  /** GET /api/community/channels/:channelId/pins — same gating as listing messages. */
  static async listPins(req: Request, res: Response): Promise<any> {
    try {
      const channelId = req.params['channelId'] as string;

      const organizer = organizerFromRequest(req);
      if (organizer) {
        const messages = await MessageService.listPinnedMessagesAsOrganizer(channelId, organizer);
        return ApiResponseUtil.success(res, messages);
      }

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const messages = await MessageService.listPinnedMessages(channelId, buyer);
      return ApiResponseUtil.success(res, messages);
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to load pinned messages');
    }
  }

  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await MessageService.markRead(req.params['channelId'] as string, buyer);
      return ApiResponseUtil.success(res, { read: true }, 'Channel marked read');
    } catch (error: any) {
      return MessageController.fail(res, error, 'Failed to mark channel read');
    }
  }
}
