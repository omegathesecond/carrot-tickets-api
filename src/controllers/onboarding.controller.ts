import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Request, Response } from 'express';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { OnboardingService } from '@services/onboarding.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';

export class OnboardingController {
  static async status(req: Request, res: Response) {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const status = await OnboardingService.status(actor);
      const canEditBrand = ((req as any).ticketsUser?.permissions || []).includes(TicketsPermission.EDIT_BRAND);
      return ApiResponseUtil.success(res, { ...status, photoRequired: !status.hasProfilePhoto && (actor.type === 'buyer' || canEditBrand) });
    } catch (error) {
      return failWithHttpError(res, error, 'Could not check onboarding requirements');
    }
  }
}
