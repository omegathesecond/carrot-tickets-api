import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockService, StockDeclinedError } from '@services/stock.service';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockMovementReason } from '@interfaces/stock.interface';

const eventId = new mongoose.Types.ObjectId();
const merchantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const base = { eventId, merchantId, productId, byType: 'Organizer' as const, by: 'o1' };

describe('StockService.applyMovement', () => {
  beforeAll(connectLedgerTestDb, 60000); // transactions need a replica set
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('receives stock: upserts the row and appends a movement', async () => {
    const { onHand, movement } = await StockService.applyMovement({
      ...base, delta: 500, reason: StockMovementReason.RECEIVE, refType: 'stock_receive', refId: 'r1',
    });
    expect(onHand).toBe(500);
    expect(movement.balanceAfter).toBe(500);
    const stock = await ProductStock.findOne({ merchantId, productId });
    expect(stock!.onHand).toBe(500);
  });

  it('a decrement CAS-guards against oversell and writes nothing on decline', async () => {
    await StockService.applyMovement({ ...base, delta: 3, reason: StockMovementReason.RECEIVE });
    await expect(
      StockService.applyMovement({ ...base, delta: -5, reason: StockMovementReason.SALE, refId: 'c1' }),
    ).rejects.toMatchObject({ reason: 'insufficient_stock', available: 3 });
    // balance untouched, no sale movement written
    expect((await ProductStock.findOne({ merchantId, productId }))!.onHand).toBe(3);
    expect(await StockMovement.countDocuments({ reason: StockMovementReason.SALE })).toBe(0);
  });

  it('a decrement with no stock row declines with available 0', async () => {
    await expect(
      StockService.applyMovement({ ...base, delta: -1, reason: StockMovementReason.SALE }),
    ).rejects.toBeInstanceOf(StockDeclinedError);
  });

  it('keeps onHand == Σ deltas after a mixed sequence', async () => {
    await StockService.applyMovement({ ...base, delta: 100, reason: StockMovementReason.RECEIVE });
    await StockService.applyMovement({ ...base, delta: -10, reason: StockMovementReason.SALE });
    await StockService.applyMovement({ ...base, delta: -4, reason: StockMovementReason.SALE });
    await StockService.applyMovement({ ...base, delta: 20, reason: StockMovementReason.RECEIVE });
    const stock = await ProductStock.findOne({ merchantId, productId });
    const rows = await StockMovement.find({ merchantId, productId });
    const sum = rows.reduce((s, r) => s + r.delta, 0);
    expect(stock!.onHand).toBe(106);
    expect(sum).toBe(106);
  });

  it('rejects a zero delta', async () => {
    await expect(
      StockService.applyMovement({ ...base, delta: 0, reason: StockMovementReason.MANUAL }),
    ).rejects.toThrow(/non-zero/);
  });

  it('N concurrent single-unit sales on the last 5 units: exactly 5 succeed, none oversell', async () => {
    await StockService.applyMovement({ ...base, delta: 5, reason: StockMovementReason.RECEIVE });
    const attempts = Array.from({ length: 12 }, (_, i) =>
      StockService.applyMovement({ ...base, delta: -1, reason: StockMovementReason.SALE, refId: `c${i}` })
        .then(() => 'ok').catch(() => 'declined'),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect((await ProductStock.findOne({ merchantId, productId }))!.onHand).toBe(0);
  });

  it('rejects a caller session that is not already in a transaction, writing nothing', async () => {
    const s = await mongoose.startSession();
    try {
      // Deliberately NOT calling s.startTransaction() — applyMovement must refuse
      // to treat a bare session as a transaction it can silently join.
      await expect(
        StockService.applyMovement({ ...base, delta: 5, reason: StockMovementReason.RECEIVE, session: s }),
      ).rejects.toThrow(/transaction/);
    } finally {
      await s.endSession();
    }
    expect(await ProductStock.findOne({ merchantId, productId })).toBeNull();
    expect(await StockMovement.countDocuments({ merchantId, productId })).toBe(0);
  });

  it('joins a valid in-transaction caller session and persists on commit', async () => {
    const s = await mongoose.startSession();
    try {
      await s.withTransaction(async () => {
        await StockService.applyMovement({ ...base, delta: 40, reason: StockMovementReason.RECEIVE, session: s });
      });
    } finally {
      await s.endSession();
    }
    const stock = await ProductStock.findOne({ merchantId, productId });
    expect(stock!.onHand).toBe(40);
    const movements = await StockMovement.find({ merchantId, productId, delta: 40 });
    expect(movements).toHaveLength(1);
  });

  it('preserves the row eventId set on insert; a later movement with a different eventId never relabels it', async () => {
    const eventA = new mongoose.Types.ObjectId();
    const eventB = new mongoose.Types.ObjectId();
    await StockService.applyMovement({ ...base, eventId: eventA, delta: 10, reason: StockMovementReason.RECEIVE });
    await StockService.applyMovement({ ...base, eventId: eventB, delta: 5, reason: StockMovementReason.RECEIVE });
    const stock = await ProductStock.findOne({ merchantId, productId });
    expect(stock!.onHand).toBe(15);
    expect(String(stock!.eventId)).toBe(String(eventA));
  });

  it('getOnHand returns 0 when no row exists, then the current balance after a receive', async () => {
    expect(await StockService.getOnHand(merchantId, productId)).toBe(0);
    await StockService.applyMovement({ ...base, delta: 12, reason: StockMovementReason.RECEIVE });
    expect(await StockService.getOnHand(merchantId, productId)).toBe(12);
  });
});
