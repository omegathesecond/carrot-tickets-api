import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HttpError } from '@utils/httpError.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { DmThreadService } from '@services/dmThread.service';
import { MessageService } from '@services/message.service';
import { createThreadSchema, sendMessageSchema } from '@validators/community.validator';

const HEX24 = /^[0-9a-f]{24}$/i;

export class DmController {
  private static fail(res: Response, error: any, fallback: string) {
    if (error instanceof HttpError) return ApiResponseUtil.error(res, error.message, error.statusCode);
    console.error(fallback, error);
    return ApiResponseUtil.error(res, error?.message || fallback, 500);
  }

  private static async requireBuyer(req: Request, res: Response) {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) {
      ApiResponseUtil.unauthorized(res, 'Please sign in first');
      return null;
    }
    return ensureUsername(buyer);
  }

  /** POST /api/dm/threads */
  static async openThread(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await DmController.requireBuyer(req, res);
      if (!buyer) return;
      const { error, value } = createThreadSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      const thread = await DmThreadService.openThread(buyer, value.participantIds);
      const view = await DmThreadService.buildThreadView(thread, buyer);
      return ApiResponseUtil.success(res, view, 'Conversation ready', 201);
    } catch (error: any) {
      return DmController.fail(res, error, 'Failed to open conversation');
    }
  }

  /** GET /api/dm/threads */
  static async listThreads(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await DmController.requireBuyer(req, res);
      if (!buyer) return;
      return ApiResponseUtil.success(res, await DmThreadService.listThreads(buyer));
    } catch (error: any) {
      return DmController.fail(res, error, 'Failed to load conversations');
    }
  }

  /** GET /api/dm/threads/:threadId/messages */
  static async listMessages(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await DmController.requireBuyer(req, res);
      if (!buyer) return;

      const rawLimit = req.query['limit'];
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) {
          return ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
        }
      }
      const before = req.query['before'] as string | undefined;
      if (before !== undefined && !HEX24.test(before)) {
        return ApiResponseUtil.error(res, 'before must be a message id', 400);
      }
      const after = req.query['after'] as string | undefined;
      if (after !== undefined && !HEX24.test(after)) {
        return ApiResponseUtil.error(res, 'after must be a message id', 400);
      }

      const messages = await MessageService.listDmMessages(req.params['threadId'] as string, buyer, {
        before,
        after,
        limit,
      });
      return ApiResponseUtil.success(res, messages);
    } catch (error: any) {
      return DmController.fail(res, error, 'Failed to load messages');
    }
  }

  /** POST /api/dm/threads/:threadId/messages */
  static async sendMessage(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await DmController.requireBuyer(req, res);
      if (!buyer) return;
      const { error, value } = sendMessageSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      const view = await MessageService.sendDmMessage(req.params['threadId'] as string, buyer, value);
      return ApiResponseUtil.success(res, view, 'Message sent', 201);
    } catch (error: any) {
      return DmController.fail(res, error, 'Failed to send message');
    }
  }

  /** POST /api/dm/threads/:threadId/read */
  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await DmController.requireBuyer(req, res);
      if (!buyer) return;
      await MessageService.markDmRead(req.params['threadId'] as string, buyer);
      return ApiResponseUtil.success(res, { read: true }, 'Conversation marked read');
    } catch (error: any) {
      return DmController.fail(res, error, 'Failed to mark read');
    }
  }
}
