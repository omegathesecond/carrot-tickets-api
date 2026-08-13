// api/src/controllers/merchant.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Wallet } from '@models/wallet.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { MerchantService, WalletDeclinedError } from '@services/merchant.service';
import { StockDeclinedError } from '@services/stock.service';
import { StockCountService } from '@services/stockCount.service';
import { StockAlertService } from '@services/stockAlert.service';
import { normalizeBandUid } from '@utils/bandUid.util';
import { chargeSchema } from '@validators/merchant.validator';
import { posCountSchema } from '@validators/stock.validator';
import { MerchantToken } from '@interfaces/merchant.interface';

/** Human-facing message per WalletDeclinedError reason, for the 402 envelope. */
const DECLINE_MESSAGE: Record<WalletDeclinedError['reason'], string> = {
  insufficient_balance: 'Insufficient balance',
  wallet_not_active: 'Wallet is not active',
  wallet_not_found: 'Wallet not found',
};

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
      // Lifecycle guard, mirroring ResellerController.cashTopup: a merchant
      // token must not be able to drain wallets at a cancelled or
      // not-yet-live event.
      if (event.status !== EventStatus.PUBLISHED) {
        return ApiResponseUtil.error(res, 'Event is not published', 400);
      }

      const bandUid = normalizeBandUid(value.bandUid);
      const wallet = await Wallet.findOne({ eventId, bandUid });
      if (!wallet) return ApiResponseUtil.notFound(res, 'No wallet for that band');

      const result = await MerchantService.charge({
        merchantId, eventId, walletId: String(wallet._id), bandUid,
        clientTxnId: value.clientTxnId,
        ...(value.amount != null ? { amount: value.amount } : {}),
        ...(value.items ? { items: value.items } : {}),
        ...(value.staffName ? { staffName: value.staffName } : {}),
      });

      if (result.charge.items?.length) {
        // Best-effort, off the money path: a notification failure logs loudly but never affects the sale.
        StockAlertService.evaluateAfterSale({
          eventId, merchantId, vendorId: String(event.vendorId),
          productIds: result.charge.items.map((i) => String(i.productId)),
        }).catch((err) => console.error('[low-stock] evaluateAfterSale failed', err));
      }

      return ApiResponseUtil.success(res, {
        newBalance: result.wallet.balance,
        amount: result.charge.amount,
        fee: result.charge.fee,
        merchantNet: result.charge.netAmount,
        ...(result.charge.items ? { items: result.charge.items } : {}),
      });
    } catch (e: any) {
      // DECLINE: an item line's stock couldn't cover the sale — 409, distinct
      // from the 402 wallet decline below, so a POS client can tell "the
      // customer's card is fine, we're out of this product" apart from "the
      // customer can't pay." Checked before WalletDeclinedError only for
      // readability — the two error classes never overlap on one throw.
      if (e instanceof StockDeclinedError) {
        return ApiResponseUtil.error(res, `Out of stock`, 409, {
          reason: e.reason, productId: e.productId, available: e.available,
        });
      }
      // DECLINE: insufficient balance / inactive wallet — 402, never 4xx/5xx,
      // so a POS client can distinguish "try a different card/band" from a
      // genuine request error. Goes through the standard ApiResponseUtil
      // envelope (success:false, message, error) like every other endpoint —
      // reason + currentBalance ride in the `error` payload, the same way
      // tickets.controller.ts's checkInTicket/reissueBand pass a structured
      // result object as ApiResponseUtil.error's 4th argument.
      if (e instanceof WalletDeclinedError) {
        return ApiResponseUtil.error(res, DECLINE_MESSAGE[e.reason], 402, {
          reason: e.reason,
          currentBalance: e.currentBalance,
        });
      }
      const msg = e?.message || 'Charge failed';
      const status = /not found|cashless|amount|not active|exactly one|products? not found|positive integer/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /**
   * GET /api/merchant/transactions — this merchant's takings: a recent-first
   * page of their charges plus a summary over ALL of them. merchantId comes
   * ONLY from the verified merchant JWT (authenticateMerchant), never a query
   * param, so a merchant can never see another merchant's charges.
   */
  static async listTransactions(req: Request, res: Response): Promise<any> {
    try {
      const merchant = (req as any).merchant as MerchantToken;
      const { merchantId } = merchant;

      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;

      const result = await MerchantService.listTransactions({ merchantId, limit });
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load transactions', 500);
    }
  }

  /** GET /api/merchant/stock — this bar's products + onHand for the stock-take screen. */
  static async stock(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const products = await Product.find({ eventId, active: true }).sort({ name: 1 }).lean();
      const rows = await ProductStock.find({ merchantId }).lean();
      const byProduct = new Map(rows.map((r) => [String(r.productId), r]));
      const stock = products.map((p) => {
        const r = byProduct.get(String(p._id));
        return { productId: String(p._id), name: p.name, unitLabel: p.unitLabel, onHand: r?.onHand ?? 0, lowStockThreshold: r?.lowStockThreshold ?? null };
      });
      return ApiResponseUtil.success(res, { stock });
    } catch (e: any) { return ApiResponseUtil.error(res, e?.message || 'Failed to load stock', 500); }
  }

  /** POST /api/merchant/stock/count — a stock-take by this bar (merchantId from JWT). */
  static async recordCount(req: Request, res: Response): Promise<any> {
    try {
      const { merchantId, eventId } = (req as any).merchant as MerchantToken;
      const { error, value } = posCountSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      const product = await Product.findById(value.productId).lean();
      if (!product || String(product.eventId) !== String(eventId)) return ApiResponseUtil.badRequest(res, 'product does not belong to this event');
      const { count, onHand } = await StockCountService.recordCount({ eventId, merchantId, productId: value.productId, countedOnHand: value.countedOnHand, phase: value.phase, byType: 'Merchant', by: merchantId });
      return ApiResponseUtil.success(res, { countId: String(count._id), expectedOnHand: count.expectedOnHand, countedOnHand: count.countedOnHand, variance: count.variance, onHand });
    } catch (e: any) { return ApiResponseUtil.error(res, e?.message || 'Count failed', 500); }
  }
}
