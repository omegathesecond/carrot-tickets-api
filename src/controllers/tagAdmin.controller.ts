import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';

const hex24 = /^[0-9a-fA-F]{24}$/;

/** Writes on a single tag. Reads live in TagReportController. */
export class TagAdminController {
  /** POST /api/tickets/events/:eventId/tags/:walletId/deactivate */
  static async deactivate(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      if (!hex24.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      // A deactivation without a reason is unauditable — the reason IS the record.
      if (!reason) return ApiResponseUtil.badRequest(res, 'reason is required');

      // Scoped read first: another event's wallet must 404, not be unbound.
      const owned = await Wallet.exists({ _id: walletId, eventId });
      if (!owned) return ApiResponseUtil.error(res, 'Tag not found', 404);

      const wallet = await WalletService.unbindBand(walletId, reason);
      return ApiResponseUtil.success(res, { walletId: String(wallet._id), bandUid: wallet.bandUid });
    } catch (err: any) {
      console.error('Tag deactivate error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to deactivate the tag', 400);
    }
  }

  /**
   * POST /api/tickets/events/:eventId/tags/:walletId/reissue
   *
   * Works from either state: a tag already reported lost (wallet unbound) or one
   * still in the attendee's hand (damaged tag swapped at the desk). The
   * still-bound case releases the old tag first with an audit reason, so the
   * binding trail never has a silent gap.
   */
  static async reissue(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      if (!hex24.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const bandUid = typeof req.body?.bandUid === 'string' ? req.body.bandUid.trim() : '';
      if (!bandUid) return ApiResponseUtil.badRequest(res, 'bandUid is required');

      const current = await Wallet.findOne({ _id: walletId, eventId });
      if (!current) return ApiResponseUtil.error(res, 'Tag not found', 404);

      // The {eventId, bandUid} partial-unique index is the real guard; this
      // read turns the race's E11000 into a sentence an organizer can act on.
      const taken = await Wallet.exists({ eventId, bandUid, _id: { $ne: walletId } });
      if (taken) return ApiResponseUtil.error(res, 'That tag is already issued at this event', 409);

      const ticketsUser = (req as any).ticketsUser;
      if (current.bandUid) {
        await WalletService.unbindBand(walletId, `reissued to ${bandUid}`);
      }
      const wallet = await WalletService.bindBand(walletId, bandUid, ticketsUser?.userId || ticketsUser?.vendorId);
      return ApiResponseUtil.success(res, { walletId: String(wallet._id), bandUid: wallet.bandUid });
    } catch (err: any) {
      if (err?.code === 11000) {
        return ApiResponseUtil.error(res, 'That tag is already issued at this event', 409);
      }
      console.error('Tag reissue error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to reissue the tag', 400);
    }
  }
}
