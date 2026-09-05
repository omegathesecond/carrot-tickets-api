import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Table } from '@models/table.model';

const EVENT = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectTestDb();
  await Table.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const open = (label: string) => ({
  eventId: EVENT, label, status: 'open' as const, openedBy: 'w1', items: [], subtotal: 0,
});

describe('a table', () => {
  it('cannot be open twice under one label at one event', async () => {
    await Table.create(open('7'));
    await expect(Table.create(open('7'))).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('frees the label again once settled, so table 7 can be reused', async () => {
    const first = await Table.create(open('7'));
    await Table.updateOne({ _id: first._id }, { $set: { status: 'settled', settledAt: new Date() } });
    const second = await Table.create(open('7'));
    expect(second.label).toBe('7');
  });

  it('rejects a non-integer line price', async () => {
    // Money is integer cents everywhere. A float here would round somewhere
    // downstream, and a bill that does not add up is worse than a refusal.
    await expect(Table.create({
      ...open('8'),
      items: [{
        merchantId: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(),
        name: 'Beer', unitPrice: 30.5, qty: 1, addedBy: 'w1', addedAt: new Date(),
      }],
    })).rejects.toThrow(/integer/i);
  });
});
