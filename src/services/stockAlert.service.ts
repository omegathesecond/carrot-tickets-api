// src/services/stockAlert.service.ts
import { ProductStock } from '@models/productStock.model';
import { NotificationService } from '@services/notification.service';

/**
 * Low-stock alerting for the cashless stock system (design §4/§7). Best-effort:
 * every method swallows its own errors (logged, never thrown) so it can be fired
 * fire-and-forget after a sale without ever affecting the money path.
 * lowStockThreshold/lowStockAlertedAt are NOT journal fields, so these direct
 * ProductStock writes do not touch the onHand==Σdelta invariant.
 */
export class StockAlertService {
  /** After a sale, for each sold product atomically arm-and-detect a downward
   *  threshold crossing, and fire one low_stock notification per crossing. */
  static async evaluateAfterSale(params: {
    eventId: string; vendorId: string; merchantId: string; productIds: string[];
  }): Promise<void> {
    const { vendorId, merchantId, productIds } = params;
    for (const productId of productIds) {
      try {
        // Fires once per crossing: the lowStockAlertedAt:null guard + $set makes
        // concurrent evaluations race-safe (only one findOneAndUpdate matches).
        const armed = await ProductStock.findOneAndUpdate(
          {
            merchantId, productId,
            lowStockThreshold: { $ne: null },
            lowStockAlertedAt: null,
            $expr: { $lte: ['$onHand', '$lowStockThreshold'] },
          },
          { $set: { lowStockAlertedAt: new Date() } },
          { new: true },
        );
        if (!armed) continue;
        await NotificationService.create(
          'vendor', vendorId, 'low_stock',
          'Low stock',
          `A product is low: ${armed.onHand} left (threshold ${armed.lowStockThreshold}).`,
          { productId: String(productId), merchantId: String(merchantId), onHand: armed.onHand, threshold: armed.lowStockThreshold },
        );
      } catch (err) {
        console.error('[low-stock] evaluateAfterSale failed for product', productId, err);
      }
    }
  }

  /** Clear the armed marker once stock is back above threshold, so the next
   *  downward crossing re-alerts. Called after a replenish (receive/transfer-in/count-up). */
  static async rearm(merchantId: string, productId: string): Promise<void> {
    try {
      await ProductStock.updateOne(
        {
          merchantId, productId,
          lowStockAlertedAt: { $ne: null },
          $expr: { $gt: ['$onHand', '$lowStockThreshold'] },
        },
        { $set: { lowStockAlertedAt: null } },
      );
    } catch (err) {
      console.error('[low-stock] rearm failed for product', productId, err);
    }
  }
}
