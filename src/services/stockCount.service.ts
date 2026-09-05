// src/services/stockCount.service.ts
import mongoose from 'mongoose';
import { StockService } from '@services/stock.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockCount, IStockCount, StockCountPhase } from '@models/stockCount.model';

export class StockCountService {
  static async recordCount(params: {
    eventId: string; merchantId: string; productId: string; countedOnHand: number;
    phase?: StockCountPhase; byType: IStockCount['byType']; by: string;
  }): Promise<{ count: IStockCount; onHand: number }> {
    const { eventId, merchantId, productId, countedOnHand, phase = 'interim', byType, by } = params;
    if (!Number.isSafeInteger(countedOnHand) || countedOnHand < 0) throw new Error('countedOnHand must be a non-negative whole number');

    const countId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    try {
      let out!: { count: IStockCount; onHand: number };
      await session.withTransaction(async () => {
        const expected = await StockService.getOnHand(merchantId, productId, session);
        const variance = countedOnHand - expected;
        if (variance !== 0) {
          await StockService.applyMovement({ eventId, merchantId, productId, delta: variance, reason: StockMovementReason.COUNT_ADJUST, refType: 'stock_count', refId: String(countId), byType, by, session });
        }
        const created = await StockCount.create([{ _id: countId, eventId, merchantId, productId, expectedOnHand: expected, countedOnHand, variance, phase, byType, by, at: new Date() }], { session });
        out = { count: created[0]!, onHand: countedOnHand };
      });
      // Best-effort re-arm (a count-up may lift onHand above threshold). Fire-and-
      // forget: it runs AFTER commit, so it must never be able to reject (and thus
      // 500) a count that already succeeded — mirrors the Task-2 transfer fix.
      StockAlertService.rearm(merchantId, productId).catch(() => {});
      return out;
    } finally {
      await session.endSession();
    }
  }
}
