import { NextFunction, Request, Response } from 'express';
import { ResellerHub } from '@models/resellerHub.model';
import { HubAnalyticsService } from '@services/hubAnalytics.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/** Load a hub only if it is within the actor's scope, else null. */
async function findScopedHub(actor: any, hubId: string) {
  const hub = await ResellerHub.findById(hubId);
  if (!hub) return null;
  if (actor.role === 'reseller_hub_manager') {
    return hub._id.toString() === actor.hubId ? hub : null;
  }
  return hub.resellerId.toString() === actor.resellerId ? hub : null;
}

function parseDate(raw: unknown, fieldName: string, res: Response): Date | null {
  const d = new Date(raw as string);
  if (isNaN(d.getTime())) {
    ApiResponseUtil.badRequest(res, `Invalid date for '${fieldName}'`);
    return null;
  }
  return d;
}

export class ResellerHubAdminController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = (req as any).reseller;
      const filter = actor.role === 'reseller_hub_manager'
        ? { _id: actor.hubId }
        : { resellerId: actor.resellerId };
      const hubs = await ResellerHub.find(filter).sort({ createdAt: -1 });
      ApiResponseUtil.success(res, hubs);
    } catch (err: any) {
      next(err);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await findScopedHub((req as any).reseller, req.params['hubId']!);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      ApiResponseUtil.success(res, hub);
    } catch (err: any) {
      next(err);
    }
  }

  static async analytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hub = await findScopedHub((req as any).reseller, req.params['hubId']!);
      if (!hub) {
        ApiResponseUtil.notFound(res, 'Hub not found');
        return;
      }
      let from: Date | undefined;
      let to: Date | undefined;
      if (req.query['from'] && req.query['to']) {
        const f = parseDate(req.query['from'], 'from', res);
        if (!f) return;
        const t = parseDate(req.query['to'], 'to', res);
        if (!t) return;
        from = f; to = t;
      }
      const analytics = await HubAnalyticsService.getHubAnalytics(req.params['hubId']!, from, to);
      ApiResponseUtil.success(res, analytics);
    } catch (err: any) {
      next(err);
    }
  }
}
