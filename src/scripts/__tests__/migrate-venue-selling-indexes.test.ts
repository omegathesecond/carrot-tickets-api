import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Table } from '@models/table.model';
import { migrateVenueSellingIndexes, main } from '../migrate-venue-selling-indexes';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const LEGACY = 'eventId_1_label_1';
const names = async () => (await Table.collection.indexes()).map((i) => i.name);
const legacy = () => Table.collection.createIndex({ eventId: 1, label: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
const venueTable = (venueId: mongoose.Types.ObjectId) => ({ venueId, label: '7', status: 'open', openedBy: 'w', items: [], subtotal: 0, orders: [], paidTotal: 0 });

describe('migrate-venue-selling-indexes', () => {
  afterEach(async () => { if ((await names()).includes(LEGACY)) await Table.collection.dropIndex(LEGACY); });

  it('with the legacy index, a second venue cannot open table 7 — the bug this fixes', async () => {
    await legacy();
    await Table.create(venueTable(new mongoose.Types.ObjectId()));
    await expect(Table.create(venueTable(new mongoose.Types.ObjectId()))).rejects.toMatchObject({ code: 11000 });
  });

  it('drops the legacy index, keeps the new ones, and the second venue can open table 7', async () => {
    await legacy();
    expect(await migrateVenueSellingIndexes()).toEqual({ legacyDropped: true });
    const after = await names();
    expect(after).not.toContain(LEGACY);
    expect(after).toEqual(expect.arrayContaining(['event_open_label_unique', 'venue_open_label_unique']));
    await Table.create(venueTable(new mongoose.Types.ObjectId()));
    await expect(Table.create(venueTable(new mongoose.Types.ObjectId()))).resolves.toBeTruthy();
  });

  it('is safe to run again', async () => {
    await legacy();
    await migrateVenueSellingIndexes();
    expect(await migrateVenueSellingIndexes()).toEqual({ legacyDropped: false });
  });

  it('refuses to run with no database named', async () => {
    const saved = process.env['MONGODB_URI'];
    delete process.env['MONGODB_URI'];
    const connect = jest.spyOn(mongoose, 'connect');
    try {
      await expect(main()).rejects.toThrow('MONGODB_URI is not set');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      if (saved !== undefined) process.env['MONGODB_URI'] = saved;
    }
  });
});
