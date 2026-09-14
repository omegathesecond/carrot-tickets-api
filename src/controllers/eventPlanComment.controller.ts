import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { listPlanComments, postPlanComment, reactToPlanComment, deleteOwnPlanComment } from '@services/eventPlanComment.service';

/** Comments on a Public Event Plan — a normal-post-style comment thread,
 *  distinct from the plan's members-only conversation (EventPlanMessageController).
 *  Buyer-only, matching every other eventPlan.route.ts endpoint. */
export class EventPlanCommentController {
  /** GET /api/social/plans/:id/comments */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      const actor = buyer ? { type: 'buyer' as const, id: String(buyer._id) } : null;
      const comments = await listPlanComments(req.params['id'] as string, actor);
      return ApiResponseUtil.success(res, { comments });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load comments');
    }
  }

  /** POST /api/social/plans/:id/comments { body, parentId? } */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      const comment = await postPlanComment(req.params['id'] as string, actor, req.body?.body, req.body?.parentId);
      return ApiResponseUtil.created(res, comment);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post comment');
    }
  }

  /** POST /api/social/plans/plan-comments/:commentId/like */
  static async like(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      return ApiResponseUtil.success(res, await reactToPlanComment(req.params['commentId'] as string, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to react to comment');
    }
  }

  /** DELETE /api/social/plans/plan-comments/:commentId — own comment only. */
  static async remove(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      await deleteOwnPlanComment(req.params['commentId'] as string, actor);
      return ApiResponseUtil.success(res, { removed: true }, 'Comment deleted');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to delete comment');
    }
  }
}
