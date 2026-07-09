import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { MessageService } from '@services/message.service';
import { HttpError } from '@utils/httpError.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { sendMessageSchema } from '@validators/community.validator';

export class MessageController {
  private static fail(res: Response, error: any, fallback: string) {
    if (error instanceof HttpError) return ApiResponseUtil.error(res, error.message, error.statusCode);
    console.error(fallback, error);
    return ApiResponseUtil.error(res, error?.message || fallback, 500);
  }

  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const rawLimit = req.query['limit'];
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) {
          return ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
        }
      }

      const before = req.query['before'] as string | undefined;
      if (before !== undefined && !/^[0-9a-f]{24}$/i.test(before)) {
        return ApiResponseUtil.error(res, 'before must be a message id', 400);
      }

      const messages = await MessageService.listMessages(req.params['channelId'] as string, buyer, {
        before,
        limit,
      });
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
}
