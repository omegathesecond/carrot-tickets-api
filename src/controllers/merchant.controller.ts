// api/src/controllers/merchant.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { MerchantService, WalletDeclinedError } from '@services/merchant.service';
import { normalizeBandUid } from '@utils/bandUid.util';
import { chargeSchema } from '@validators/merchant.validator';
import { MerchantToken } from '@interfaces/merchant.interface';

export class MerchantController {
  /**
   * POST /api/merchant/charge — tap-to-pay: debit the tapped band's wallet
   * and credit this merchant + the platform fee (cashless spec).
   * merchantId/eventId come ONLY from the verified merchant JWT
   * (authenticateMerchant), never the request body, so a merchant can never
   * charge as another merchant or against a different event.
   */
  static async charge(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = chargeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const merchant = (req as any).merchant as MerchantToken;
      const { merchantId, eventId } = merchant;

      const event = await Event.findById(eventId).lean();
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!event.cashless) return ApiResponseUtil.error(res, 'Event is not cashless', 400);

      const bandUid = normalizeBandUid(value.bandUid);
      const wallet = await Wallet.findOne({ eventId, bandUid });
      if (!wallet) return ApiResponseUtil.notFound(res, 'No wallet for that band');

      const result = await MerchantService.charge({
        merchantId,
        eventId,
        walletId: String(wallet._id),
        bandUid,
        amount: value.amount,
        clientTxnId: value.clientTxnId,
      });

      return ApiResponseUtil.success(res, {
        ok: true,
        newBalance: result.wallet.balance,
        amount: result.charge.amount,
        fee: result.charge.fee,
        merchantNet: result.charge.netAmount,
      });
    } catch (e: any) {
      // DECLINE: insufficient balance / inactive wallet — 402, never 4xx/5xx,
      // so a POS client can distinguish "try a different card/band" from a
      // genuine request error.
      if (e instanceof WalletDeclinedError) {
        return res.status(402).json({
          ok: false,
          reason: e.reason,
          currentBalance: e.currentBalance,
        });
      }
      const msg = e?.message || 'Charge failed';
      const status = /not found|cashless|amount|not active/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }
}
