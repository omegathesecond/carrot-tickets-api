import { Request, Response } from 'express';
import { resolveBuyerFromRequest } from '@/utils/buyerRequest.util';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { SavedContentService } from '@services/savedContent.service';
import { UpdateService } from '@services/update.service';
import { buildEventCards } from '@services/eventCards.service';

export class ConsumerReadsController {
  /** GET /api/social/me/saved */
  static async mySaved(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const actor = { type: 'buyer' as const, id: String(buyer._id) };
      const [savedUpdateDocs, savedEventIds] = await Promise.all([
        SavedContentService.listSavedUpdates(actor.id),
        SavedContentService.savedEventIds(actor.id),
      ]);
      const [updates, events] = await Promise.all([
        UpdateService.buildUpdateSlides(savedUpdateDocs, actor),
        buildEventCards(savedEventIds, actor),
      ]);
      return ApiResponseUtil.success(res, { updates, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load saved items');
    }
  }
}
