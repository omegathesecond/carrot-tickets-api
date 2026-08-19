import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockMovement } from '@models/stockMovement.model';
import { StockMovementReason } from '@interfaces/stock.interface';

const id = () => new mongoose.Types.ObjectId();

describe('StockMovement model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('records a signed delta and balanceAfter', async () => {
    const m = await StockMovement.create({
      eventId: id(), merchantId: id(), productId: id(),
      delta: -1, reason: StockMovementReason.SALE, balanceAfter: 144,
      byType: 'Merchant', by: 'm1',
    });
    expect(m.delta).toBe(-1);
    expect(m.balanceAfter).toBe(144);
  });

  it('rejects a non-integer delta', async () => {
    await expect(
      StockMovement.create({
        eventId: id(), merchantId: id(), productId: id(),
        delta: 1.5, reason: StockMovementReason.RECEIVE, balanceAfter: 10,
        byType: 'Organizer', by: 'o1',
      }),
    ).rejects.toThrow();
  });
});
