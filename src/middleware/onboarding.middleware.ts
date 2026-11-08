import { Request, Response, NextFunction } from 'express';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { OnboardingService } from '@services/onboarding.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/** Applied before API routers so public/optional-auth reads cannot bypass the
 * signed-in account's requirements. Writes, account recovery, checkout and
 * onboarding reads remain available. Profile permission is independent of browse. */
export async function enforceOnboarding(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!['GET', 'HEAD'].includes(req.method) || !req.headers.authorization) return next();
  // Express routes are case-insensitive and decode path parameters. Match
  // that behavior so casing or percent encoding cannot bypass the guard.
  let path: string;
  try { path = decodeURIComponent(req.path).toLowerCase().replace(/\/+$/, ''); }
  catch (error) { next(error); return; }
  const profile = path.match(/^\/api\/(?:tickets\/social\/users|social\/users|public\/organizers|public\/services)\/([^/]+)(?:\/reviews)?$/);
  const author = path.match(/^\/api\/public\/updates\/by\/(buyer|vendor)\/([^/]+)$/);
  const userProfile = profile && !['search'].includes(profile[1]!);
  const browse = /^\/api\/public\/(events|calendar|activity|activity-feed|trending|topics|question-events|questions|feed|updates|weekend-recaps|whats-hot|services)(\/|$)/.test(path)
    || /^\/api\/(?:tickets\/)?social\/(recommendations|nearby|stories|users\/search|me\/following\/events|plans|weekend)(\/|$)/.test(path)
    || /^\/api\/(marketplace|community)(\/|$)/.test(path);
  if (!userProfile && !author && !browse) return next();
  // Ticket preparation is a recovery flow, not a platform browse surface.
  if (/^\/api\/public\/events\/[^/]+\/(preparation|companions)(\/|$)/.test(path)) return next();
  await authenticateTickets(req, res, async (authError?: unknown) => {
    if (authError) return next(authError);
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) { ApiResponseUtil.unauthorized(res, 'Please sign in first'); return; }
      const status = await OnboardingService.status(actor);
      if (userProfile || author) {
        const target = decodeURIComponent((profile?.[1] ?? author?.[2])!);
        const own = author
          ? author[1] === actor.type && target === actor.id
          : path.includes('/social/users/')
            ? actor.type === 'buyer' && (target === actor.id || target.toLowerCase() === status.username?.toLowerCase())
            : actor.type === 'vendor' && target === actor.id;
        if (own) return next();
        if (!status.canViewProfiles) {
          ApiResponseUtil.error(res, 'Upload at least 3 images or videos to view other users’ profiles', 403, 'MEDIA_REQUIRED');
          return;
        }
      } else if (!status.canBrowse) {
        ApiResponseUtil.error(res, 'Follow at least 10 Carrot users to browse the platform', 403, 'FOLLOWING_REQUIRED');
        return;
      }
      next();
    } catch (error) { next(error); }
  });
}
