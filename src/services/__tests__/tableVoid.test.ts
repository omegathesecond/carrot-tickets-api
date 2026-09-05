import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedStallAndTable, onHandFor } from '@/__tests__/helpers/tables';
import { TableService } from '@services/table.service';
import { Table } from '@models/table.model';

// addItem (used to put a line on the table before voiding) needs a replica
// set for its transaction, same as every other suite in this file's family.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('TableService.voidTable', () => {
  it('closes the table unpaid and does NOT return the stock', async () => {
    // The drinks were consumed or walked. Returning them to the shelf would make
    // a real loss look like it never happened; a voided table IS the record of it.
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await TableService.addItem({ tableId: String(table._id), eventId: String(table.eventId), merchantId, productId, qty: 2, addedBy: 'w1' });

    const after = await TableService.voidTable({ tableId: String(table._id), eventId: String(table.eventId), reason: 'walked out', voidedBy: 'w1' });

    expect(after.status).toBe('voided');
    expect(after.voidReason).toBe('walked out');
    expect(after.subtotal).toBe(6000);
    expect(await onHandFor(merchantId, productId)).toBe(8);
  });

  it('requires a reason', async () => {
    const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await expect(TableService.voidTable({ tableId: String(table._id), eventId: String(table.eventId), reason: '  ', voidedBy: 'w1' }))
      .rejects.toThrow(/reason is required/i);
  });

  it('will not void a settled table', async () => {
    const { table } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await Table.updateOne({ _id: table._id }, { $set: { status: 'settled' } });
    await expect(TableService.voidTable({ tableId: String(table._id), eventId: String(table.eventId), reason: 'oops', voidedBy: 'w1' }))
      .rejects.toThrow(/not open/i);
  });

  // A waiter's eventId comes from their own verified token (see
  // loadWaiterEvent), never from the table id itself — so a table that
  // belongs to a DIFFERENT event must be refused exactly like a missing one,
  // and left completely untouched. A rejection that still flipped the
  // table's status would be the bug this guards against.
  it('will not void a table belonging to a different event', async () => {
    const { table: mine } = await seedStallAndTable({ price: 3000, onHand: 10 });
    const foreignTable = await Table.create({
      eventId: new mongoose.Types.ObjectId(), label: 'F1', status: 'open',
      openedBy: 'w0', items: [], subtotal: 0,
    });

    await expect(TableService.voidTable({
      tableId: String(foreignTable._id), eventId: String(mine.eventId), reason: 'oops', voidedBy: 'w1',
    })).rejects.toThrow(/not found/i);

    const stillThere = await Table.findById(foreignTable._id);
    expect(stillThere!.status).toBe('open');
  });
});
