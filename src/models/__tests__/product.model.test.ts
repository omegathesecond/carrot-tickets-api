import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Product } from '@models/product.model';
import { ProductCategory } from '@interfaces/stock.interface';

const eventId = () => new mongoose.Types.ObjectId();

describe('Product model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a product with defaults', async () => {
    const p = await Product.create({
      eventId: eventId(), name: 'Castle Lite 330ml',
      category: ProductCategory.BEER, price: 2500,
    });
    expect(p.price).toBe(2500);
    expect(p.unitLabel).toBe('unit');
    expect(p.active).toBe(true);
  });

  it('rejects a non-integer price', async () => {
    await expect(
      Product.create({ eventId: eventId(), name: 'x', category: ProductCategory.OTHER, price: 25.5 }),
    ).rejects.toThrow();
  });

  it('enforces barcode uniqueness per event, but allows many barcodeless products', async () => {
    const ev = eventId();
    await Product.create({ eventId: ev, name: 'A', category: ProductCategory.BEER, price: 100, barcode: '6001240100015' });
    await expect(
      Product.create({ eventId: ev, name: 'B', category: ProductCategory.BEER, price: 100, barcode: '6001240100015' }),
    ).rejects.toThrow(); // duplicate barcode, same event

    // two products with NO barcode in the same event must both succeed
    await Product.create({ eventId: ev, name: 'Ice', category: ProductCategory.OTHER, price: 500 });
    await expect(
      Product.create({ eventId: ev, name: 'Cup', category: ProductCategory.OTHER, price: 200 }),
    ).resolves.toBeDefined();

    // same barcode is fine at a DIFFERENT event
    await expect(
      Product.create({ eventId: eventId(), name: 'A2', category: ProductCategory.BEER, price: 100, barcode: '6001240100015' }),
    ).resolves.toBeDefined();
  });
});
