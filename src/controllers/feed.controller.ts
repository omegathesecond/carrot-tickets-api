import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { getFeed, FeedSlide } from '@services/feed.service';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { getViewerReactions } from '@services/update.service';

const TABS = ['for-you', 'following', 'events'] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

export class FeedController {
  static async get(req: Request, res: Response): Promise<any> {
    const tab = String(req.query['tab'] || 'for-you');
    if (!isTab(tab)) return ApiResponseUtil.validationError(res, 'Invalid tab');
    const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
    const buyer = await resolveBuyerFromRequest(req).catch(() => null);
    try {
      const { items, nextCursor } = await getFeed({ tab, cursor, buyerId: buyer ? String(buyer._id) : undefined });
      if (buyer) {
        const updateIds = items.filter((i) => i.type === 'update').map((i) => i.id);
        if (updateIds.length) {
          const rx = await getViewerReactions(updateIds, String(buyer._id));
          for (const i of items as FeedSlide[]) {
            if (i.type === 'update') i['viewerReactions'] = rx[i.id] ?? null;
          }
        }
      }
      return ApiResponseUtil.success(res, { items, nextCursor });
    } catch (err: any) {
      return ApiResponseUtil.error(res, err?.message || 'Failed to load feed', 500);
    }
  }
}
