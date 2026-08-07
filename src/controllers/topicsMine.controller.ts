import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { listMine, markRead } from '@services/topicsMine.service';

/**
 * "YOUR TOPICS" — the signed-in actor's own topics + read cursor, for the
 * TopicsPage. Mounted with optionalTicketsAuth (buyer OR vendor token); both
 * endpoints require a resolved actor and 401 without one — there is no
 * anonymous "your topics".
 */
export class TopicsMineController {
  /** GET /api/community/questions/mine */
  static async listMine(req: Request, res: Response): Promise<any> {
    try {
      // A write-like read: it's inherently personal, so a failure resolving
      // the actor must surface (not degrade to an anonymous 200 with []).
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const requested = parseInt(String(req.query['limit'] ?? '30'), 10);
      const limit = Number.isFinite(requested) ? requested : 30;
      const topics = await listMine(actor, limit);
      return ApiResponseUtil.success(res, { topics });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load your topics');
    }
  }

  /** POST /api/community/questions/:questionId/read */
  static async markRead(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const questionId = req.params['questionId'] as string;
      return ApiResponseUtil.success(res, await markRead(questionId, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark topic read');
    }
  }
}
