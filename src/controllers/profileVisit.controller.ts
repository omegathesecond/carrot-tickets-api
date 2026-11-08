import { Request, Response } from 'express';
import { ProfileVisitService } from '@services/profileVisit.service';
import { resolveActorFromRequest, SocialActorType } from '@utils/socialActor.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';

export class ProfileVisitController {
  static async visit(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      const result = await ProfileVisitService.visit(
        String(req.params['targetType']) as SocialActorType,
        String(req.params['targetId']),
        typeof req.body?.visitorId === 'string' ? req.body.visitorId : '',
        actor,
      );
      res.setHeader('Cache-Control', 'no-store');
      return ApiResponseUtil.success(res, result);
    } catch (error) {
      return failWithHttpError(res, error, 'Could not load profile views');
    }
  }
}
