import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedStall, seedStallAndTable, onHandFor, EVENT } from '@/__tests__/helpers/tables';
import { TableService } from '@services/table.service';
import { Table } from '@models/table.model';
import { Product } from '@models/product.model';
import { Merchant } from '@models/merchant.model';

beforeAll(connectLedgerTestDb, 60000); // StockService.applyMovement needs a replica set for its transaction
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('TableService.addItem', () => {
  it('snapshots the price and moves the stall stock', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });

    const after = await TableService.addItem({
      tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 2, addedBy: 'w1',
    });

    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.unitPrice).toBe(3000);
    expect(after.items[0]!.name).toBe('Beer');
    expect(after.subtotal).toBe(6000);
    // The drinks left the shelf when the waiter took them, not when the tab is
    // paid — a stall whose count only moves at settle is wrong all night.
    expect(await onHandFor(merchantId, productId)).toBe(8);
  });

  it('reprices nothing when the stall changes its price afterwards', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await TableService.addItem({ tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1' });
    await Product.updateOne({ _id: productId }, { $set: { price: 4000 } });

    const after = await TableService.addItem({ tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1' });

    expect(after.items[0]!.unitPrice).toBe(3000);
    expect(after.items[1]!.unitPrice).toBe(4000);
    expect(after.subtotal).toBe(7000);
  });

  it('holds items from two different stalls on one table', async () => {
    const a = await seedStallAndTable({ price: 3000, onHand: 10 });
    const b = await seedStall({ price: 1500, onHand: 10 });
    await TableService.addItem({ tableId: String(a.table._id), eventId: String(EVENT), merchantId: a.merchantId, productId: a.productId, qty: 1, addedBy: 'w1' });
    const after = await TableService.addItem({ tableId: String(a.table._id), eventId: String(EVENT), merchantId: b.merchantId, productId: b.productId, qty: 1, addedBy: 'w1' });

    expect(new Set(after.items.map((i: { merchantId: unknown }) => String(i.merchantId))).size).toBe(2);
    expect(after.subtotal).toBe(4500);
  });

  it('refuses a product that belongs to another stall', async () => {
    const a = await seedStallAndTable({ price: 3000, onHand: 10 });
    const b = await seedStall({ price: 1500, onHand: 10 });
    await expect(TableService.addItem({
      tableId: String(a.table._id), eventId: String(EVENT), merchantId: a.merchantId, productId: b.productId, qty: 1, addedBy: 'w1',
    })).rejects.toThrow(/not sold at that stall/i);
  });

  // Settlement's guarded flip names the revision it priced at, so an add that
  // did not bump it would be invisible to that guard — see ITable.revision.
  it('bumps the table revision on every add', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    expect(table.revision).toBe(0);

    const once = await TableService.addItem({
      tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1',
    });
    expect(once.revision).toBe(1);

    const twice = await TableService.addItem({
      tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1',
    });
    expect(twice.revision).toBe(2);
  });

  it('refuses to add to a settled table', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await Table.updateOne({ _id: table._id }, { $set: { status: 'settled' } });
    await expect(TableService.addItem({
      tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1',
    })).rejects.toThrow(/not open/i);
  });

  // Design doc's failure-modes section, second half: suspension blocks NEW
  // items, distinct from "stall not found for this event" above — that's a
  // wrong/nonexistent stall, this is a real stall the organizer switched off.
  // Nothing may be written on a refused add: not the line, not the subtotal,
  // and — the whole point — not the stock, or a closed stall keeps selling
  // through the one route that never checked its till login or its charge.
  it('refuses an item from a suspended stall, leaving the tab and the shelf untouched', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });
    await Merchant.updateOne({ _id: merchantId }, { $set: { status: 'suspended' } });

    await expect(TableService.addItem({
      tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1',
    })).rejects.toThrow(/closed/i);

    const after = await Table.findById(table._id);
    expect(after!.items).toHaveLength(0);
    expect(after!.subtotal).toBe(0);
    expect(await onHandFor(merchantId, productId)).toBe(10);
  });

  // Guards against over-refusing: an active stall — the default, and the
  // common case all night — must keep working once the suspended check exists.
  it('still allows an item from an active stall', async () => {
    const { table, merchantId, productId } = await seedStallAndTable({ price: 3000, onHand: 10 });

    const after = await TableService.addItem({
      tableId: String(table._id), eventId: String(EVENT), merchantId, productId, qty: 1, addedBy: 'w1',
    });

    expect(after.items).toHaveLength(1);
    expect(await onHandFor(merchantId, productId)).toBe(9);
  });
});
