import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { listQuestions, listRecent, createQuestion, createReply, toggleQuestionLike } from '@services/eventQuestion.service';

/**
 * Event Q&A — questions/replies/likes scoped to an event, for the
 * TopicsPage discussion threads. Mounted with optionalTicketsAuth (accepts a
 * buyer OR vendor token, or anonymous); reads degrade gracefully to an
 * anonymous view, writes 401 when no actor resolves.
 */
export class EventQuestionController {
  /** GET /api/community/:eventId/questions */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const eventId = req.params['eventId'] as string;
      // A failed lookup here just means an unpersonalized (viewerHasLiked:false)
      // view, same call as update.controller's listByEvent/listByAuthor — a DB
      // blip resolving the actor shouldn't turn a read into a 500.
      const actor = await resolveActorFromRequest(req).catch(() => null);
      return ApiResponseUtil.success(res, await listQuestions(eventId, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load questions');
    }
  }

  /**
   * GET /api/public/questions
   * The most recent Q&A questions ACROSS ALL events, newest first — powers
   * the TopicsPage cross-event discussion list (the per-event thread is the
   * `list` method above). Public + optionalTicketsAuth: an anonymous caller
   * just gets viewerHasLiked:false on every row, same graceful degrade as
   * `list`.
   */
  static async listRecent(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req).catch(() => null);
      const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      const questions = await listRecent(actor, limit);
      return ApiResponseUtil.success(res, { questions });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load recent questions');
    }
  }

  /** POST /api/community/:eventId/questions */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      // NOT `.catch(() => null)`: this is a write, so a real error resolving
      // the actor (a DB blip, not "no token") must surface as a 500, not a
      // misleading "please sign in" to someone who is in fact signed in. See
      // the identical reasoning in eventReaction.controller's like().
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const eventId = req.params['eventId'] as string;
      const question = await createQuestion(eventId, actor, req.body?.body);
      return ApiResponseUtil.created(res, question);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post question');
    }
  }

  /** POST /api/community/questions/:questionId/replies */
  static async reply(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const questionId = req.params['questionId'] as string;
      const reply = await createReply(questionId, actor, req.body?.body);
      return ApiResponseUtil.created(res, reply);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post reply');
    }
  }

  /** POST /api/community/questions/:questionId/like */
  static async like(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const questionId = req.params['questionId'] as string;
      return ApiResponseUtil.success(res, await toggleQuestionLike(questionId, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to like question');
    }
  }
}
