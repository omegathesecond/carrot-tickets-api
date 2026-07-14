import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { DmThreadService } from '@services/dmThread.service';
import { MessageService } from '@services/message.service';
import { sendMessageSchema } from '@validators/community.validator';
import { failWithHttpError, parseMessageCursorParams, HEX24 } from '@utils/controllerHelpers.util';
import type { SocialActor } from '@utils/socialActor.util';

/**
 * Brand (organizer) side of DMs. Reuses the SAME generalized DmThreadService /
 * MessageService as the buyer path — the only difference is the acting
 * identity (`{ type: 'vendor', id: vendorId }`). Mounted at /api/tickets/dm.
 */
export class VendorDmController {
  private static actor(req: Request): SocialActor | null {
    const vendorId = (req as any).ticketsUser?.vendorId;
    return vendorId ? { type: 'vendor', id: String(vendorId) } : null;
  }

  private static fail(res: Response, error: any, fallback: string) {
    return failWithHttpError(res, error, fallback);
  }

  /** POST /api/tickets/dm/threads { buyerId } — open (or reuse) a 1:1 with a buyer. */
  static async openThread(req: Request, res: Response): Promise<any> {
    try {
      const actor = VendorDmController.actor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const buyerId = String(req.body?.buyerId || '');
      if (!HEX24.test(buyerId)) return ApiResponseUtil.error(res, 'buyerId is required', 400);
      const thread = await DmThreadService.openVendorThread(actor.id, buyerId);
      const view = await DmThreadService.buildThreadView(thread, actor);
      return ApiResponseUtil.success(res, view, 'Conversation ready', 201);
    } catch (error: any) {
      return VendorDmController.fail(res, error, 'Failed to open conversation');
    }
  }

  /** GET /api/tickets/dm/threads */
  static async listThreads(req: Request, res: Response): Promise<any> {
    try {
      const actor = VendorDmController.actor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await DmThreadService.listThreads(actor));
    } catch (error: any) {
      return VendorDmController.fail(res, error, 'Failed to load conversations');
    }
  }

  /** GET /api/tickets/dm/threads/:threadId/messages */
  static async listMessages(req: Request, res: Response): Promise<any> {
    try {
      const actor = VendorDmController.actor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      const messages = await MessageService.listDmMessages(req.params['threadId'] as string, actor, params);
      return ApiResponseUtil.success(res, messages);
    } catch (error: any) {
      return VendorDmController.fail(res, error, 'Failed to load messages');
    }
  }

  /** POST /api/tickets/dm/threads/:threadId/messages { body, replyTo? } */
  static async sendMessage(req: Request, res: Response): Promise<any> {
    try {
      const actor = VendorDmController.actor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = sendMessageSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      const view = await MessageService.sendDmMessage(req.params['threadId'] as string, actor, value);
      return ApiResponseUtil.success(res, view, 'Message sent', 201);
    } catch (error: any) {
      return VendorDmController.fail(res, error, 'Failed to send message');
    }
  }

  /** POST /api/tickets/dm/threads/:threadId/read */
  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const actor = VendorDmController.actor(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await MessageService.markDmRead(req.params['threadId'] as string, actor);
      return ApiResponseUtil.success(res, { read: true }, 'Conversation marked read');
    } catch (error: any) {
      return VendorDmController.fail(res, error, 'Failed to mark read');
    }
  }
}
