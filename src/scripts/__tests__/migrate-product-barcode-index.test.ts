import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Product } from '@models/product.model';
import { main, migrateProductBarcodeIndex } from '../migrate-product-barcode-index';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const LEGACY = 'eventId_1_barcode_1';
const coll = () => mongoose.connection.db!.collection('products');
const id = () => new mongoose.Types.ObjectId();
const product = (owner: Record<string, unknown>, barcode = '6001240100015') =>
  Product.create({ ...owner, name: 'Coke 330ml', category: 'soft_drink', price: 1500, barcode });

async function createLegacyIndex() {
  await coll().createIndex(
    { eventId: 1, barcode: 1 },
    { name: LEGACY, unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
  );
}

describe('product barcode indexes', () => {
  afterEach(async () => {
    const names = (await coll().indexes()).map((i) => i.name);
    if (names.includes(LEGACY)) await coll().dropIndex(LEGACY);
  });

  it('the legacy index makes the same barcode at two venues collide (the bug)', async () => {
    await createLegacyIndex();
    await product({ venueId: id() });
    await expect(product({ venueId: id() })).rejects.toMatchObject({ code: 11000 });
  });

  it('the migration drops the legacy index; per-owner uniqueness then holds', async () => {
    await createLegacyIndex();
    expect(await migrateProductBarcodeIndex()).toEqual({ legacyDropped: true });
    const names = (await coll().indexes()).map((i) => i.name);
    expect(names).not.toContain(LEGACY);
    expect(names).toEqual(expect.arrayContaining(['event_barcode_unique', 'venue_barcode_unique']));

    const venueA = id(); const venueB = id(); const eventA = id();
    await product({ venueId: venueA });
    await product({ venueId: venueB });                 // other venue: allowed
    await product({ eventId: eventA });                 // an event: allowed
    await expect(product({ venueId: venueA })).rejects.toMatchObject({ code: 11000 }); // same venue
    await expect(product({ eventId: eventA })).rejects.toMatchObject({ code: 11000 }); // same event
  });

  it('is idempotent', async () => {
    expect(await migrateProductBarcodeIndex()).toEqual({ legacyDropped: false });
  });

  it('products without a barcode never collide', async () => {
    const venue = id();
    await Product.create({ venueId: venue, name: 'Ice', category: 'other', price: 500 });
    await Product.create({ venueId: venue, name: 'Cups', category: 'other', price: 100 });
    expect(await Product.countDocuments({ venueId: venue })).toBe(2);
  });
});

describe('the CLI entrypoint', () => {
  const saved = process.env['MONGODB_URI'];
  afterEach(() => {
    if (saved === undefined) delete process.env['MONGODB_URI'];
    else process.env['MONGODB_URI'] = saved;
  });

  it('refuses to run with no MONGODB_URI rather than falling back to a local database', async () => {
    delete process.env['MONGODB_URI'];
    const connect = jest.spyOn(mongoose, 'connect');
    await expect(main()).rejects.toThrow('MONGODB_URI is not set');
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });
});
