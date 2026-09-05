import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedStallAndTable, onHandFor, EVENT } from '@/__tests__/helpers/tables';
import { TableService } from '@services/table.service';
import { Table } from '@models/table.model';

// removeItem writes its line-pull + compensating stock-return in one
// transaction (same reasoning as addItem), so this suite needs a replica set.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('TableService.removeItem', () => {
  it('returns the stock — this is the mis-punch, the drink never left the counter', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    const withItem = await TableService.addItem({ tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 2, addedBy: 'w1' });
    expect(await onHandFor(merchantId, productId)).toBe(8);

    const after = await TableService.removeItem({
      tableId: String(table._id), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
    });

    expect(after.items).toHaveLength(0);
    expect(after.subtotal).toBe(0);
    expect(await onHandFor(merchantId, productId)).toBe(10);
  });

  it('refuses on a settled table', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    const withItem = await TableService.addItem({ tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1' });
    await Table.updateOne({ _id: table._id }, { $set: { status: 'settled' } });

    await expect(TableService.removeItem({
      tableId: String(table._id), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
    })).rejects.toThrow(/not open/i);
  });

  it('404s a line that is not on this table', async () => {
    const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await expect(TableService.removeItem({
      tableId: String(table._id), lineId: String(new mongoose.Types.ObjectId()), removedBy: 'w1',
    })).rejects.toThrow(/line not found/i);
  });
});
