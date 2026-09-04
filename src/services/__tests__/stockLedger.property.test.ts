import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockMovementReason } from '@interfaces/stock.interface';

// Deterministic PRNG (no Math.random — reproducible failures).
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

describe('stock ledger invariant: onHand == Σ deltas', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('holds after 200 random receive/sale movements', async () => {
    const eventId = new mongoose.Types.ObjectId();
    const merchantId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const base = { eventId, merchantId, productId, byType: 'Organizer' as const, by: 'o1' };
    const rng = makeRng(42);

    for (let i = 0; i < 200; i++) {
      const isReceive = rng() < 0.5;
      const qty = 1 + Math.floor(rng() * 20);
      try {
        await StockService.applyMovement({
          ...base,
          delta: isReceive ? qty : -qty,
          reason: isReceive ? StockMovementReason.RECEIVE : StockMovementReason.SALE,
          refId: `m${i}`,
        });
      } catch (e) {
        // Declines (oversell attempts) are expected and must leave state consistent.
        expect(e).toBeInstanceOf(StockDeclinedError);
      }
    }

    const stock = await ProductStock.findOne({ merchantId, productId });
    const rows = await StockMovement.find({ merchantId, productId });
    const sum = rows.reduce((s, r) => s + r.delta, 0);
    expect(stock!.onHand).toBe(sum);
    expect(stock!.onHand).toBeGreaterThanOrEqual(0);
    // balanceAfter of the last movement equals the final onHand.
    const last = rows.sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1);
    if (last) expect(last.balanceAfter).toBe(stock!.onHand);
  });
});
