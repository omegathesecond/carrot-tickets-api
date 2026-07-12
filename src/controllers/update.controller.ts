import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { createUpdate, finalizeUpdate, getUpdate, toggleReaction, recordShare, getViewerReactions } from '@services/update.service';
import { Update } from '@models/update.model';

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export class UpdateController {
  static async create(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const { kind, caption = '', eventId, ext, contentType } = req.body || {};
    if (kind !== 'video' && kind !== 'image') return ApiResponseUtil.validationError(res, 'kind must be video or image');
    const allow = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
    if (!allow.includes(contentType)) return ApiResponseUtil.validationError(res, `Invalid contentType for ${kind}`);
    if (typeof caption === 'string' && caption.length > 500) return ApiResponseUtil.validationError(res, 'caption too long');
    try {
      const { update, uploadUrl } = await createUpdate({
        authorType: 'buyer', authorId: String(buyer._id), kind, caption, eventId, ext: String(ext || 'bin'), contentType,
      });
      return ApiResponseUtil.created(res, { updateId: update.id, uploadUrl });
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to create update', 500);
    }
  }

  static async finalize(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
    const update = await Update.findById(req.params['id'] as string);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    if (String(update.authorId) !== String(buyer._id)) return ApiResponseUtil.forbidden(res, 'Not your update');
    try {
      const out = await finalizeUpdate(update.id);
      return ApiResponseUtil.success(res, UpdateController.dto(out));
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to finalize', 500);
    }
  }

  static async getOne(req: Request, res: Response): Promise<any> {
    const update = await getUpdate(req.params['id'] as string);
    if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
    let reactions: { liked: boolean; saved: boolean } | undefined;
    const buyer = await resolveBuyerFromRequest(req).catch(() => null);
    if (buyer) reactions = (await getViewerReactions([update.id], String(buyer._id)))[update.id];
    return ApiResponseUtil.success(res, UpdateController.dto(update, reactions));
  }

  static react(type: 'like' | 'save') {
    return async (req: Request, res: Response): Promise<any> => {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const update = await Update.findById(req.params['id'] as string).select('_id status');
      if (!update || update.status === 'removed') return ApiResponseUtil.notFound(res, 'Update not found');
      const r = await toggleReaction(req.params['id'] as string, String(buyer._id), type);
      return ApiResponseUtil.success(res, r);
    };
  }

  static async share(req: Request, res: Response): Promise<any> {
    const r = await recordShare(req.params['id'] as string);
    return ApiResponseUtil.success(res, r);
  }

  static async remove(req: Request, res: Response): Promise<any> {
    const buyer = await resolveBuyerFromRequest(req);
    const isSuperAdmin = (req as any).ticketsUser?.isSuperAdmin === true;
    const update = await Update.findById(req.params['id'] as string);
    if (!update) return ApiResponseUtil.notFound(res, 'Update not found');
    const isAuthor = buyer && String(update.authorId) === String(buyer._id);
    if (!isAuthor && !isSuperAdmin) return ApiResponseUtil.forbidden(res, 'Not allowed');
    update.status = 'removed';
    await update.save();
    return ApiResponseUtil.success(res, { ok: true });
  }

  static dto(update: any, reactions?: { liked: boolean; saved: boolean }) {
    return {
      id: update.id,
      authorType: update.authorType,
      authorId: String(update.authorId),
      kind: update.kind,
      caption: update.caption,
      eventId: update.eventId ? String(update.eventId) : null,
      media: update.media,
      likeCount: update.likeCount,
      saveCount: update.saveCount,
      shareCount: update.shareCount,
      createdAt: update.createdAt,
      viewerReactions: reactions ?? null,
    };
  }
}
