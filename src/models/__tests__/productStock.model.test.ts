import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { ProductStock } from '@models/productStock.model';

const id = () => new mongoose.Types.ObjectId();

describe('ProductStock model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults onHand to 0', async () => {
    const s = await ProductStock.create({ eventId: id(), merchantId: id(), productId: id() });
    expect(s.onHand).toBe(0);
  });

  it('is unique per (merchant, product)', async () => {
    await ProductStock.init();
    const merchantId = id(); const productId = id();
    await ProductStock.create({ eventId: id(), merchantId, productId, onHand: 10 });
    await expect(
      ProductStock.create({ eventId: id(), merchantId, productId, onHand: 5 }),
    ).rejects.toThrow();
  });
});
