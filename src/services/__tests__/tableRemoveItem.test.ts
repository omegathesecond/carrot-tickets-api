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
  // Settlement's guarded flip names the revision it priced at, so a removal
  // that did not bump it would be invisible to that guard — and a removal is
  // half of the equal-value swap subtotal cannot see. See ITable.revision.
  it('bumps the table revision on every removal', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    const withItem = await TableService.addItem({ tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1' });
    expect(withItem.revision).toBe(1);

    const after = await TableService.removeItem({
      tableId: String(table._id), eventId: String(EVENT), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
    });

    expect(after.revision).toBe(2);
  });

  it('returns the stock — this is the mis-punch, the drink never left the counter', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    const withItem = await TableService.addItem({ tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 2, addedBy: 'w1' });
    expect(await onHandFor(merchantId, productId)).toBe(8);

    const after = await TableService.removeItem({
      tableId: String(table._id), eventId: String(EVENT), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
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
      tableId: String(table._id), eventId: String(EVENT), lineId: String(withItem.items[0]!._id), removedBy: 'w1',
    })).rejects.toThrow(/not open/i);
  });

  it('404s a line that is not on this table', async () => {
    const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await expect(TableService.removeItem({
      tableId: String(table._id), eventId: String(EVENT), lineId: String(new mongoose.Types.ObjectId()), removedBy: 'w1',
    })).rejects.toThrow(/line not found/i);
  });

  // A waiter's eventId comes from their own verified token, never from the
  // table id itself — so a table belonging to a DIFFERENT event must be
  // refused exactly like a missing one, and its line left completely
  // untouched. A rejection that still pulled the line or moved stock back
  // would be the bug this guards against.
  it('will not touch a table belonging to a different event', async () => {
    const merchantId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const lineId = new mongoose.Types.ObjectId();
    const foreignTable = await Table.create({
      eventId: new mongoose.Types.ObjectId(), label: 'F1', status: 'open', openedBy: 'w0',
      subtotal: 6000,
      items: [{ _id: lineId, merchantId, productId, name: 'Beer', unitPrice: 3000, qty: 2, addedBy: 'w0', addedAt: new Date() }],
    });

    await expect(TableService.removeItem({
      tableId: String(foreignTable._id), eventId: String(EVENT), lineId: String(lineId), removedBy: 'w1',
    })).rejects.toThrow(/not found/i);

    const stillThere = await Table.findById(foreignTable._id);
    expect(stillThere!.items).toHaveLength(1);
    expect(stillThere!.subtotal).toBe(6000);
  });
});
