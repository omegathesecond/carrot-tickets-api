import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { createStory, finalizeStory, listForViewer, markSeen } from '@services/story.service';
import { Story } from '@models/story.model';
import type { StoryKind } from '@interfaces/story.interface';

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Buyer-only ephemeral (24h) media posts. All routes mount behind
 * authenticateBuyer (see @routes/social.route), so the actor is always
 * `{ type: 'buyer', id }` — mirrors @controllers/update.controller's
 * buyer-post path.
 */
export class StoryController {
  static async create(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const { kind, ext, contentType } = req.body || {};
    if (kind !== 'video' && kind !== 'image') return ApiResponseUtil.validationError(res, 'kind must be video or image');
    const allow = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
    if (!allow.includes(contentType)) return ApiResponseUtil.validationError(res, `Invalid contentType for ${kind}`);
    try {
      const { story, uploadUrl } = await createStory({
        actor: { type: 'buyer', id: String(buyer._id) },
        kind: kind as StoryKind,
        ext: String(ext || 'bin'),
        contentType,
      });
      return ApiResponseUtil.created(res, { storyId: story.id, uploadUrl });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create story');
    }
  }

  static async finalize(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    const existing = await Story.findById(id).select('authorType authorId');
    if (!existing) return ApiResponseUtil.notFound(res, 'Story not found');
    if (existing.authorType !== 'buyer' || String(existing.authorId) !== String(buyer._id)) {
      return ApiResponseUtil.forbidden(res, 'Not your story');
    }
    try {
      const story = await finalizeStory(id);
      return ApiResponseUtil.success(res, { id: story.id, kind: story.kind, media: story.media });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to finalize story');
    }
  }

  static async list(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    try {
      const stories = await listForViewer({ type: 'buyer', id: String(buyer._id) });
      return ApiResponseUtil.success(res, { stories });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load stories');
    }
  }

  static async seen(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const id = req.params['id'] as string;
    if (!HEX24.test(id)) return ApiResponseUtil.validationError(res, 'Invalid story id');
    try {
      await markSeen(id, { type: 'buyer', id: String(buyer._id) });
      return ApiResponseUtil.success(res, { ok: true });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark story seen');
    }
  }
}
