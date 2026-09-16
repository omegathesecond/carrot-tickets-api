import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { EventPlanMessageService } from '@services/eventPlanMessage.service';

export class EventPlanMessageController {
  /** GET /api/social/plans/:id/messages?before=&limit= */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      const before = req.query['before'] ? String(req.query['before']) : undefined;
      const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      const messages = await EventPlanMessageService.list(
        String(req.params['id'] || ''),
        buyer ? String(buyer._id) : null,
        before,
        limit
      );
      return ApiResponseUtil.success(res, { messages });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load messages');
    }
  }

  /** POST /api/social/plans/:id/messages { body, replyTo? } */
  static async send(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const message = await EventPlanMessageService.send(
        buyer,
        String(req.params['id'] || ''),
        String(req.body?.body || ''),
        req.body?.replyTo ? String(req.body.replyTo) : undefined
      );
      return ApiResponseUtil.created(res, { message });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to send message');
    }
  }

  /** POST /api/social/plans/:id/posts { kind, body?, replyTo?, items, clientToken? }
   *  Returns { message, uploads } — client uploads each file to uploads[i].uploadUrl,
   *  then calls finalize. */
  static async createPost(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { kind, body, replyTo, items, clientToken } = req.body || {};
      const result = await EventPlanMessageService.createPost(buyer, String(req.params['id'] || ''), {
        kind,
        body,
        replyTo,
        items: Array.isArray(items) ? items : [],
        clientToken,
      });
      return ApiResponseUtil.created(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create post');
    }
  }

  /** POST /api/social/plans/:id/posts/:messageId/finalize */
  static async finalizePost(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const message = await EventPlanMessageService.finalizePost(buyer, String(req.params['id'] || ''), String(req.params['messageId'] || ''));
      return ApiResponseUtil.success(res, { message });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to finalize post');
    }
  }

  /** PATCH /api/social/plans/:id/messages/:messageId { body } */
  static async editCaption(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const message = await EventPlanMessageService.editCaption(
        buyer,
        String(req.params['id'] || ''),
        String(req.params['messageId'] || ''),
        String(req.body?.body ?? '')
      );
      return ApiResponseUtil.success(res, { message });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to edit post');
    }
  }

  /** DELETE /api/social/plans/:id/messages/:messageId */
  static async remove(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanMessageService.deletePost(buyer, String(req.params['id'] || ''), String(req.params['messageId'] || ''));
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to delete post');
    }
  }

  /** POST /api/social/plans/:id/read */
  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanMessageService.markRead(buyer, String(req.params['id'] || ''));
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update read status');
    }
  }

  /** POST /api/social/plans/:id/messages/:messageId/react { emoji } */
  static async react(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanMessageService.react(
        buyer,
        String(req.params['id'] || ''),
        String(req.params['messageId'] || ''),
        String(req.body?.emoji || '')
      );
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to react to message');
    }
  }

  /** DELETE /api/social/plans/:id/messages/:messageId/react */
  static async unreact(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await EventPlanMessageService.unreact(buyer, String(req.params['id'] || ''), String(req.params['messageId'] || ''));
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to remove reaction');
    }
  }
}
