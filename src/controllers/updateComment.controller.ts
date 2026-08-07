import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { listComments, createComment, removeComment } from '@services/updateComment.service';

const isSuperAdmin = (req: Request) => (req as any).ticketsUser?.isSuperAdmin === true;

/**
 * Comments on Discover posts (Updates). All three routes are mounted with
 * optionalTicketsAuth so a buyer OR an organizer brand can comment with the
 * same endpoint — authorization happens here and in the service, exactly like
 * UpdateController.remove.
 */
export class UpdateCommentController {
  /** GET /api/public/updates/:id/comments */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      // `.catch(() => null)` on a READ only: a blip resolving the actor should
      // cost the viewer their delete affordances, not turn the thread into a
      // 500. The writes below deliberately do NOT swallow it.
      const actor = await resolveActorFromRequest(req).catch(() => null);
      const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
      const out = await listComments(req.params['id'] as string, actor, cursor, isSuperAdmin(req));
      return ApiResponseUtil.success(res, out);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load comments');
    }
  }

  /** POST /api/public/updates/:id/comments */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      // NOT `.catch(() => null)`: on a write, a real failure resolving the
      // actor must surface as a 500 rather than telling someone who IS signed
      // in to sign in. Same reasoning as EventQuestionController.create.
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const comment = await createComment(req.params['id'] as string, actor, req.body?.body);
      return ApiResponseUtil.created(res, comment);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post comment');
    }
  }

  /** DELETE /api/public/updates/comments/:commentId */
  static async remove(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      const superAdmin = isSuperAdmin(req);
      if (!actor && !superAdmin) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const out = await removeComment(req.params['commentId'] as string, actor, superAdmin);
      return ApiResponseUtil.success(res, out);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to delete comment');
    }
  }
}
