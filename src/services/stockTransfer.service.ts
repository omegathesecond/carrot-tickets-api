// src/services/stockTransfer.service.ts
import mongoose from 'mongoose';
import { StockService } from '@services/stock.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockTransfer, IStockTransfer } from '@models/stockTransfer.model';
import { ScopeIds, scopeMatch } from '@utils/tradingScope.util';

export class StockTransferService {
  static async transfer(params: ScopeIds & {
    productId: string; fromMerchantId: string; toMerchantId: string;
    qty: number; byType: IStockTransfer['byType']; by: string; note?: string;
  }): Promise<{ transfer: IStockTransfer; fromOnHand: number; toOnHand: number }> {
    const { productId, fromMerchantId, toMerchantId, qty, byType, by, note } = params;
    const owner = scopeMatch(params);
    if (fromMerchantId === toMerchantId) throw new Error('cannot transfer to the same bar');
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('qty must be a positive whole number');

    const transferId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    try {
      let out!: { transfer: IStockTransfer; fromOnHand: number; toOnHand: number };
      await session.withTransaction(async () => {
        const outMove = await StockService.applyMovement({ ...owner, merchantId: fromMerchantId, productId, delta: -qty, reason: StockMovementReason.TRANSFER_OUT, refType: 'stock_transfer', refId: String(transferId), byType, by, note, session });
        const inMove = await StockService.applyMovement({ ...owner, merchantId: toMerchantId, productId, delta: qty, reason: StockMovementReason.TRANSFER_IN, refType: 'stock_transfer', refId: String(transferId), byType, by, note, session });
        const created = await StockTransfer.create([{ _id: transferId, ...owner, productId, fromMerchantId, toMerchantId, qty, byType, by, note, at: new Date() }], { session });
        out = { transfer: created[0]!, fromOnHand: outMove.onHand, toOnHand: inMove.onHand };
      });
      // Best-effort re-arm the destination (a transfer-in may lift it above threshold).
      // Fire-and-forget: it runs AFTER commit, so it must never be able to reject
      // (and thus 500) a transfer that already succeeded. rearm() already logs its
      // own errors internally.
      StockAlertService.rearm(toMerchantId, productId).catch(() => {});
      return out;
    } finally {
      await session.endSession();
    }
  }
}
