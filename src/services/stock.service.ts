import mongoose, { ClientSession } from 'mongoose';
import { ProductStock, IProductStock } from '@models/productStock.model';
import { StockMovement, IStockMovement } from '@models/stockMovement.model';
import { StockMovementReason, StockMovementByType } from '@interfaces/stock.interface';

export class StockDeclinedError extends Error {
  readonly reason = 'insufficient_stock';
  constructor(public productId: string, public available: number) {
    super(`insufficient_stock: product ${productId} has ${available} on hand`);
    this.name = 'StockDeclinedError';
  }
}

export interface MovementInput {
  eventId: string | mongoose.Types.ObjectId;
  merchantId: string | mongoose.Types.ObjectId;
  productId: string | mongoose.Types.ObjectId;
  /** Signed base units, non-zero. > 0 adds (upserts the row), < 0 CAS-decrements. */
  delta: number;
  reason: StockMovementReason;
  refType?: string;
  refId?: string;
  byType: StockMovementByType;
  by: string;
  note?: string;
  /** Join a caller transaction (e.g. the item-sale charge, Slice 2). */
  session?: ClientSession;
}

/**
 * The ONLY writer of ProductStock.onHand and StockMovement (design §5). A
 * movement atomically CAS-updates onHand and appends a balanced journal row,
 * so onHand == Σ(deltas) holds by construction. A decrement below zero throws
 * StockDeclinedError and writes nothing — hard-block-at-zero, no silent clamp.
 */
export class StockService {
  static async applyMovement(input: MovementInput): Promise<{ onHand: number; movement: IStockMovement }> {
    const { delta, reason, refType, refId, byType, by, note } = input;
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new Error(`delta must be a non-zero whole number of base units, got ${delta}`);
    }
    const eventId = toId(input.eventId);
    const merchantId = toId(input.merchantId);
    const productId = toId(input.productId);

    if (input.session && !input.session.inTransaction()) {
      throw new Error('applyMovement requires the caller session to be in a transaction');
    }

    const work = async (session: ClientSession) => {
      const decrement = delta < 0;
      const filter: Record<string, unknown> = { merchantId, productId };
      // CAS guard: a decrement matches only when there is enough on hand.
      if (decrement) filter['onHand'] = { $gte: -delta };

      const stock = (await ProductStock.findOneAndUpdate(
        filter,
        // $ifNull covers the upsert-insert case where onHand doesn't exist yet.
        [{ $set: { onHand: { $add: [{ $ifNull: ['$onHand', 0] }, delta] }, eventId } }],
        { new: true, upsert: !decrement, setDefaultsOnInsert: true, session },
      )) as IProductStock | null;

      if (!stock) {
        // Decrement declined (or no row at all). Re-read to report the true available.
        const existing = await ProductStock.findOne({ merchantId, productId }, { onHand: 1 }, { session });
        throw new StockDeclinedError(String(productId), existing?.onHand ?? 0);
      }

      const created = await StockMovement.create(
        [{ eventId, merchantId, productId, delta, reason, balanceAfter: stock.onHand, refType, refId, byType, by, note, at: new Date() }],
        { session },
      );
      // create([oneDoc]) always resolves exactly one element; noUncheckedIndexedAccess
      // just can't see that statically.
      const movement = created[0]!;
      return { onHand: stock.onHand, movement };
    };

    if (input.session) return work(input.session);

    const session = await mongoose.startSession();
    try {
      let result!: { onHand: number; movement: IStockMovement };
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** Current on-hand for a bar-product; 0 when no row exists. Reporting only. */
  static async getOnHand(
    merchantId: string | mongoose.Types.ObjectId,
    productId: string | mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<number> {
    const q = ProductStock.findOne({ merchantId: toId(merchantId), productId: toId(productId) }, { onHand: 1 });
    const row = await (session ? q.session(session) : q);
    return row?.onHand ?? 0;
  }
}

function toId(v: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
  return typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v;
}
