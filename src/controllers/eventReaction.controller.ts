import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { Event } from '@models/event.model';
import { toggleEventLike, recordEventShare } from '@services/eventReaction.service';

/**
 * Likes/shares on an event, mounted as an event sub-resource alongside
 * /events/:eventId/reviews (ReviewController) rather than growing
 * PublicController.
 */
export class EventReactionController {
  /**
   * Returns the eventId if the event exists; otherwise sends a 404 response and returns null.
   */
  private static async requireEvent(req: Request, res: Response): Promise<string | null> {
    const eventId = req.params['eventId'] as string;
    if (!(await Event.exists({ _id: eventId }))) {
      ApiResponseUtil.error(res, 'Event not found', 404);
      return null;
    }
    return eventId;
  }

  /** POST /api/public/events/:eventId/like — 401 when anonymous. */
  static async like(req: Request, res: Response): Promise<any> {
    try {
      // NOT `.catch(() => null)` (which feed.controller uses): there, a failed
      // lookup just means no personalisation. Here it would turn a real error
      // — a DB blip mid-lookup — into a misleading "please sign in", telling a
      // signed-in user to do something that won't help. Let it reach the catch
      // below and surface as a 500. An ABSENT actor still returns null without
      // throwing, so anonymous is unaffected.
      const actor = await resolveActorFromRequest(req);
      // The route is optionalTicketsAuth (the feed shares it), so an anonymous
      // caller reaches here. A like needs an owner: refuse, never no-op.
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const eventId = await EventReactionController.requireEvent(req, res);
      if (!eventId) return;

      return ApiResponseUtil.success(res, await toggleEventLike(eventId, actor));
    } catch (error: any) {
      return ApiResponseUtil.error(res, error?.message || 'Failed to like event', 500);
    }
  }

  /** POST /api/public/events/:eventId/share — no actor required. */
  static async share(req: Request, res: Response): Promise<any> {
    try {
      const eventId = await EventReactionController.requireEvent(req, res);
      if (!eventId) return;
      return ApiResponseUtil.success(res, await recordEventShare(eventId));
    } catch (error: any) {
      return ApiResponseUtil.error(res, error?.message || 'Failed to record share', 500);
    }
  }
}
