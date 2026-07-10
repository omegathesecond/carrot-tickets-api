import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername } from '@utils/username.util';
import { DmThreadService } from '@services/dmThread.service';
import { MessageService } from '@services/message.service';
import { createThreadSchema, sendMessageSchema } from '@validators/community.validator';
import { failWithHttpError, parseMessageCursorParams } from '@utils/controllerHelpers.util';

export class DmController {
  private static fail(res: Response, error: any, fallback: string) {
    return failWithHttpError(res, error, fallback);
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

      const params = parseMessageCursorParams(req, res);
      if (!params) return;

      const messages = await MessageService.listDmMessages(req.params['threadId'] as string, buyer, params);
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
