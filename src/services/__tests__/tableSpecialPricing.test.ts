import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedStallAndTable, onHandFor, EVENT } from '@/__tests__/helpers/tables';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { Product } from '@models/product.model';
import { Wallet } from '@models/wallet.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { TableService } from '@services/table.service';
import { WalletService } from '@services/wallet.service';
import { priceTableLines } from '@utils/tablePrice.util';
import { ITableLine } from '@interfaces/table.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const waiterId = String(new mongoose.Types.ObjectId());
const tag = '04a22b1c';
async function specialTable() {
  const seeded = await seedStallAndTable({ price: 3500, onHand: 100, commissionPercent: 10 });
  await Product.updateOne({ _id: seeded.productId }, { $set: { bundlePrice: { quantity: 6, price: 19000 } } });
  return seeded;
}

it('prices six across rounds, reprices removal and returns only the removed units', async () => {
  const { table, merchantId, productId } = await specialTable();
  const args = { tableId: String(table._id), eventId: String(EVENT), addedBy: waiterId };
  const first = await TableService.addItems({ ...args, items: [{ merchantId, productId, qty: 2 }] });
  expect(first.subtotal).toBe(7000);
  const six = await TableService.addItems({ ...args, items: [{ merchantId, productId, qty: 4 }] });
  expect(six.subtotal).toBe(19000);
  expect(six.items[0]!.bundlePrice).toMatchObject({ quantity: 6, price: 19000 });
  expect(await onHandFor(merchantId, productId)).toBe(94);
  expect((await TableService.quote(args.tableId, args.eventId)).subtotal).toBe(19000);
  const four = await TableService.removeItem({ ...args, lineId: String(six.items[0]!._id), removedBy: waiterId });
  expect(four.subtotal).toBe(14000);
  expect(await onHandFor(merchantId, productId)).toBe(96);
});

it('charges 10 at 330, with one stock deduction and an accurate discount receipt and ledger', async () => {
  const { table, merchantId, productId } = await specialTable();
  const args = { tableId: String(table._id), eventId: String(EVENT), addedBy: waiterId };
  for (const qty of [4, 6]) await TableService.addItems({ ...args, items: [{ merchantId, productId, qty }] });
  const quote = await TableService.quote(args.tableId, args.eventId);
  expect(quote).toEqual({ subtotal: 33000, purchaseChargeAmount: 0, total: 33000 });
  await enrolTags(EVENT, tag);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({ eventId: String(EVENT), bandUid: tag });
  await WalletService.topUpAtDesk({ method: 'cash', walletId: String(wallet._id), eventId: String(EVENT), amount: 33000,
    recordedBy: 'fixture', recordedByType: 'Cashier', clientTxnId: 'fund-special' });
  const settle = { tableId: args.tableId, eventId: args.eventId, bandUid: tag, settledBy: waiterId,
    staffName: 'Waiter', clientTxnId: 'special-table', quotedTotal: quote.total };
  await expect(TableService.settle({ ...settle, quotedTotal: 35000 })).rejects.toThrow();
  expect((await Wallet.findById(wallet._id))!.balance).toBe(33000);
  const paid = await TableService.settle(settle);
  expect(paid.table.subtotal).toBe(33000);
  expect(paid.walletBalance).toBe(0);
  expect(await onHandFor(merchantId, productId)).toBe(90);
  expect(paid.charges).toHaveLength(1);
  expect(paid.charges[0]).toMatchObject({ amount: 33000, fee: 3300, netAmount: 29700 });
  expect(paid.charges[0]!.items).toHaveLength(1);
  expect(paid.charges[0]!.items![0]).toMatchObject({ qty: 10, lineTotal: 33000,
    pricing: { regularUnits: 4, specialUnits: 6, specialBundles: 1, discountAmount: 2000 } });
  const entries = await LedgerEntry.find({ refType: 'table_settlement', refId: args.tableId }).lean();
  expect(entries).toHaveLength(3);
  expect(entries.reduce((sum, leg) => sum + leg.delta, 0)).toBe(0);
  expect(new Set(entries.map(entry => entry.txnId)).size).toBe(1);
  const replay = await TableService.settle(settle);
  expect(String(replay.charges[0]!._id)).toBe(String(paid.charges[0]!._id));
  expect(await onHandFor(merchantId, productId)).toBe(90);
});

it('keeps the original offer when the catalogue changes, without combining different snapshots', async () => {
  const { table, merchantId, productId } = await specialTable();
  const args = { tableId: String(table._id), eventId: String(EVENT), addedBy: waiterId };
  await TableService.addItems({ ...args, items: [{ merchantId, productId, qty: 6 }] });
  await Product.updateOne({ _id: productId }, { $set: { bundlePrice: { quantity: 6, price: 18000 } } });
  const after = await TableService.addItems({ ...args, items: [{ merchantId, productId, qty: 6 }] });
  expect(after.subtotal).toBe(37000);
  expect((await TableService.quote(args.tableId, args.eventId)).subtotal).toBe(37000);
});

it('never combines specials between stalls or products and leaves non-special items at unit price', () => {
  const line = { _id: new mongoose.Types.ObjectId(), merchantId: new mongoose.Types.ObjectId(),
    productId: new mongoose.Types.ObjectId(), name: 'Beer', unitPrice: 3500, qty: 3,
    bundlePrice: { quantity: 6, price: 19000 }, addedBy: waiterId, addedAt: new Date() } as ITableLine;
  const result = priceTableLines([line, { ...line, merchantId: new mongoose.Types.ObjectId() },
    { ...line, productId: new mongoose.Types.ObjectId() }, { ...line, qty: 6, bundlePrice: null }]);
  expect(result.subtotal).toBe(52500);
  expect(result.items).toHaveLength(4);
});
