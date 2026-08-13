// src/services/stockTransfer.service.ts
import mongoose from 'mongoose';
import { StockService } from '@services/stock.service';
import { StockAlertService } from '@services/stockAlert.service';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';
import { StockTransfer, IStockTransfer } from '@models/stockTransfer.model';

export class StockTransferService {
  static async transfer(params: {
    eventId: string; productId: string; fromMerchantId: string; toMerchantId: string;
    qty: number; byType: StockMovementByType; by: string; note?: string;
  }): Promise<{ transfer: IStockTransfer; fromOnHand: number; toOnHand: number }> {
    const { eventId, productId, fromMerchantId, toMerchantId, qty, byType, by, note } = params;
    if (fromMerchantId === toMerchantId) throw new Error('cannot transfer to the same bar');
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('qty must be a positive whole number');

    const transferId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    try {
      let out!: { transfer: IStockTransfer; fromOnHand: number; toOnHand: number };
      await session.withTransaction(async () => {
        const outMove = await StockService.applyMovement({ eventId, merchantId: fromMerchantId, productId, delta: -qty, reason: StockMovementReason.TRANSFER_OUT, refType: 'stock_transfer', refId: String(transferId), byType, by, note, session });
        const inMove = await StockService.applyMovement({ eventId, merchantId: toMerchantId, productId, delta: qty, reason: StockMovementReason.TRANSFER_IN, refType: 'stock_transfer', refId: String(transferId), byType, by, note, session });
        const created = await StockTransfer.create([{ _id: transferId, eventId, productId, fromMerchantId, toMerchantId, qty, byType, by, note, at: new Date() }], { session });
        out = { transfer: created[0]!, fromOnHand: outMove.onHand, toOnHand: inMove.onHand };
      });
      // Best-effort re-arm the destination (a transfer-in may lift it above threshold).
      await StockAlertService.rearm(toMerchantId, productId);
      return out;
    } finally {
      await session.endSession();
    }
  }
}
