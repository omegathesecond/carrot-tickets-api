import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { WalletService, WalletIdempotencyMismatchError } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';
import { FloatTag } from '@interfaces/ledger.interface';
import { assertValidBandUid } from '@utils/bandUid.util';

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

      const rawUid = typeof req.body?.bandUid === 'string' ? req.body.bandUid.trim() : '';
      if (!rawUid) return ApiResponseUtil.badRequest(res, 'bandUid is required');
      // Canonical form BEFORE the pre-check below, or a `7A:0E:00:01` typed
      // for a tag issued as `7a0e0001` would sail past it — and the wallet
      // service would refuse the malformed ones anyway; better a 400 up front.
      let bandUid: string;
      try {
        bandUid = assertValidBandUid(rawUid);
      } catch (e: any) {
        return ApiResponseUtil.badRequest(res, e?.message || 'invalid band uid');
      }

      const current = await Wallet.findOne({ _id: walletId, eventId });
      if (!current) return ApiResponseUtil.error(res, 'Tag not found', 404);

      // The {eventId, bandUid} partial-unique index is the real guard; this
      // read turns the race's E11000 into a sentence an organizer can act on.
      const taken = await Wallet.exists({ eventId, bandUid, _id: { $ne: walletId } });
      if (taken) return ApiResponseUtil.error(res, 'That tag is already issued at this event', 409);

      const ticketsUser = (req as any).ticketsUser;
      // Validates the replacement (registered, not retired, not live elsewhere)
      // BEFORE releasing the current tag, and restores it if the bind still
      // loses a race — the attendee is never left tagless by a failed reissue.
      const wallet = await WalletService.reissueBand(
        walletId, bandUid, `reissued to ${bandUid}`, ticketsUser?.userId || ticketsUser?.vendorId,
      );
      return ApiResponseUtil.success(res, { walletId: String(wallet._id), bandUid: wallet.bandUid });
    } catch (err: any) {
      if (err?.code === 11000 || /already bound to another wallet/i.test(err?.message || '')) {
        return ApiResponseUtil.error(res, 'That tag is already issued at this event', 409);
      }
      console.error('Tag reissue error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to reissue the tag', 400);
    }
  }

  /**
   * POST /api/tickets/events/:eventId/tags/:walletId/refund
   *
   * RECORDS cash handed back at the office — it does not send money anywhere.
   * Same money path as a cashier's cash-out (see WalletService.withdrawCash),
   * labelled office_cash so venue cash reconciliation stays honest.
   */
  static async refund(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const walletId = String(req.params['walletId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      if (!hex24.test(walletId)) return ApiResponseUtil.badRequest(res, 'invalid tag id');

      const amount = Number(req.body?.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        return ApiResponseUtil.badRequest(res, 'amount must be a positive whole number of cents');
      }
      // Client-supplied so a double-submit cannot double-refund.
      const clientTxnId = typeof req.body?.clientTxnId === 'string' ? req.body.clientTxnId.trim() : '';
      if (!clientTxnId) return ApiResponseUtil.badRequest(res, 'clientTxnId is required');

      const owned = await Wallet.exists({ _id: walletId, eventId });
      if (!owned) return ApiResponseUtil.error(res, 'Tag not found', 404);

      const ticketsUser = (req as any).ticketsUser;
      const { wallet, withdrawal } = await WalletService.withdrawCash({
        walletId, eventId, amount, clientTxnId,
        recordedBy: (ticketsUser?.userId || ticketsUser?.vendorId) as string,
        method: 'office_cash', recordedByType: 'Vendor', floatTag: FloatTag.OFFICE,
      });

      return ApiResponseUtil.success(res, {
        walletId: String(wallet._id), balance: wallet.balance, withdrawalId: String(withdrawal._id),
      });
    } catch (err: any) {
      // A reused clientTxnId with a different amount is a conflict, not a replay.
      if (err instanceof WalletIdempotencyMismatchError) return ApiResponseUtil.error(res, err.message, 409);
      // A decline is not a server error — say which one it was.
      if (err?.reason === 'insufficient_balance') return ApiResponseUtil.error(res, 'The tag does not hold that much', 402);
      if (err?.reason === 'wallet_not_active') return ApiResponseUtil.error(res, 'This tag is not active', 409);
      if (err?.reason === 'wallet_not_found') return ApiResponseUtil.error(res, 'Tag not found', 404);
      console.error('Tag refund error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to record the refund', 400);
    }
  }
}
