import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { EVENT, seedStall } from '@/__tests__/helpers/tables';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { TableService } from '@services/table.service';
import { WalletService } from '@services/wallet.service';
import { Table } from '@models/table.model';
import { Wallet, IWallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { ITable } from '@interfaces/table.interface';

// Settlement writes the table flip, the wallet debit, the ledger postings and
// every MerchantCharge in ONE transaction, so this suite needs a replica set.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/**
 * The waiter doing the settling. A real ObjectId, not a nickname: the charge
 * rows carry `waiterId` as a Waiter ref (task 11), so a settle attributed to
 * 'w1' would fail to cast rather than record who took the money.
 */
const WAITER = new mongoose.Types.ObjectId();
const TAG = '04a22b1c';

let labelSeq = 0;

interface TwoStallTable {
  table: ITable;
  stallA: string;
  stallB: string;
  productA: string;
  productB: string;
}

/**
 * One open table carrying a line from EACH of two stalls — the shape the whole
 * feature exists for. `a`/`b` are the line totals (one unit each), and each
 * stall carries its OWN commission so a settle that leaked one rate onto the
 * other's line shows up in the numbers.
 *
 * Built through TableService.addItem rather than by writing the items array
 * directly, so the lines (and their price snapshots) are exactly what a waiter
 * would really have put there.
 */
async function seedTwoStallTable(opts: {
  a: number; b: number; commissionA: number; commissionB: number;
}): Promise<TwoStallTable> {
  const A = await seedStall({ price: opts.a, onHand: 10, name: 'Beer', commissionPercent: opts.commissionA });
  const B = await seedStall({ price: opts.b, onHand: 10, name: 'Wine', commissionPercent: opts.commissionB });

  const opened = await Table.create({
    eventId: EVENT, label: `S${labelSeq++}`, status: 'open',
    openedBy: String(WAITER), items: [], subtotal: 0,
  });
  const args = { tableId: String(opened._id), eventId: String(EVENT), qty: 1, addedBy: String(WAITER) };
  await TableService.addItem({ ...args, merchantId: A.merchantId, productId: A.productId });
  const table = await TableService.addItem({ ...args, merchantId: B.merchantId, productId: B.productId });

  return { table, stallA: A.merchantId, stallB: B.merchantId, productA: A.productId, productB: B.productId };
}

/**
 * A standalone (no ticket) wallet on EVENT holding `amount` cents, reachable by
 * tapping `bandUid` — built the way the cash desk really builds one, so the
 * balance under test came from a real top-up with its own ledger legs rather
 * than a hand-written balance the ledger knows nothing about.
 */
async function fundedWallet(amount: number, bandUid: string): Promise<IWallet> {
  await enrolTags(EVENT, bandUid);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({
    eventId: String(EVENT), bandUid,
  });
  const { wallet: funded } = await WalletService.topUpCash({
    walletId: String(wallet._id), eventId: String(EVENT), amount,
    recordedBy: 'fixture-desk', recordedByType: 'Cashier', clientTxnId: `fund-${wallet._id}`,
  });
  return funded;
}

/** The settle args every test varies only a little of. */
function settleArgs(table: ITable, clientTxnId: string) {
  return {
    tableId: String(table._id), eventId: String(EVENT), bandUid: TAG,
    settledBy: String(WAITER), staffName: 'Thabo', clientTxnId,
  };
}

describe('TableService.settle', () => {
  it('pays every stall from one tap, each at its own commission', async () => {
    const { table, stallA, stallB } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 10, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);

    const { charges } = await TableService.settle(settleArgs(table, 's1'));

    expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
    const byStall = Object.fromEntries(charges.map((c) => [String(c.merchantId), c]));
    expect(byStall[stallA]!.amount).toBe(3000);
    expect(byStall[stallA]!.netAmount).toBe(2700); // 10% commission
    expect(byStall[stallA]!.fee).toBe(300);
    expect(byStall[stallB]!.amount).toBe(1500);
    expect(byStall[stallB]!.netAmount).toBe(1500); // 0%
    expect(byStall[stallB]!.fee).toBe(0);
  });

  // The rate is the stall's, read at settle time — not the table's, and not
  // whatever it was when the drink was poured.
  it('uses the rate the stall carries at settle time, not the one it had when the drink was served', async () => {
    const { table, stallA } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 10, commissionB: 0 });
    await fundedWallet(10000, TAG);
    await Merchant.updateOne({ _id: stallA }, { $set: { commissionPercent: 20 } });

    const { charges } = await TableService.settle(settleArgs(table, 's1'));

    const a = charges.find((c) => String(c.merchantId) === stallA)!;
    expect(a.fee).toBe(600);
    expect(a.netAmount).toBe(2400);
  });

  it('posts ONE balanced journal entry for the whole table', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 10, commissionB: 0 });
    await fundedWallet(10000, TAG);

    await TableService.settle(settleArgs(table, 's1'));

    const entries = await LedgerEntry.find({ refType: 'table_settlement', refId: String(table._id) });
    const sum = entries.reduce((t, e) => t + e.delta, 0);
    expect(sum).toBe(0);
    // one wallet debit + two merchant credits + one fee credit
    expect(entries).toHaveLength(4);
    // ONE entry, not two: every leg shares a txnId, so the fan-out across
    // stalls is still a single journal entry.
    expect(new Set(entries.map((e) => e.txnId)).size).toBe(1);
  });

  // Commission rarely divides into whole cents. Flooring is the rule, and
  // `net` is a SUBTRACTION from the same gross rather than a second
  // percentage, so the half-cent the platform gives up cannot also go missing
  // from the entry — the legs still sum to zero on numbers that do not divide.
  it('keeps the entry balanced when neither stall commission divides into whole cents', async () => {
    const { table, stallA, stallB } = await seedTwoStallTable({ a: 3333, b: 1667, commissionA: 7, commissionB: 3 });
    const wallet = await fundedWallet(10000, TAG);

    const { charges } = await TableService.settle(settleArgs(table, 's1'));

    const byStall = Object.fromEntries(charges.map((c) => [String(c.merchantId), c]));
    expect(byStall[stallA]!.fee).toBe(233);      // floor(3333 * 7 / 100) = 233.31 -> 233
    expect(byStall[stallA]!.netAmount).toBe(3100);
    expect(byStall[stallB]!.fee).toBe(50);       // floor(1667 * 3 / 100) = 50.01 -> 50
    expect(byStall[stallB]!.netAmount).toBe(1617);
    for (const c of charges) expect(c.fee + c.netAmount).toBe(c.amount);

    const entries = await LedgerEntry.find({ refType: 'table_settlement', refId: String(table._id) });
    expect(entries.reduce((t, e) => t + e.delta, 0)).toBe(0);
    expect(entries).toHaveLength(5); // wallet + 2 merchants + 2 fees
    expect((await Wallet.findById(wallet._id))!.balance).toBe(5000);
  });

  it('charges nothing at all when the tag is short, and names the shortfall', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(3000, TAG);

    await expect(TableService.settle(settleArgs(table, 's1'))).rejects.toThrow(/R15\.00 short/);

    expect((await Wallet.findById(wallet._id))!.balance).toBe(3000);
    expect(await MerchantCharge.countDocuments({})).toBe(0);
    expect(await LedgerEntry.countDocuments({ refType: 'table_settlement' })).toBe(0);
    expect((await Table.findById(table._id))!.status).toBe('open');
  });

  it('refuses a second concurrent settle rather than billing twice', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    await fundedWallet(10000, TAG);
    const call = () => TableService.settle(settleArgs(table, `s-${Math.random()}`));

    const results = await Promise.allSettled([call(), call()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await MerchantCharge.countDocuments({})).toBe(2); // two stalls, one settlement
    expect((await Wallet.findById((await Table.findById(table._id))!.walletId))!.balance).toBe(5500);
  });

  it('replays a retried settle instead of billing twice', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);
    const args = settleArgs(table, 'same');

    const first = await TableService.settle(args);
    const retry = await TableService.settle(args);

    expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
    expect(await MerchantCharge.countDocuments({})).toBe(2);
    // The retry must answer with the SAME charges, not an empty success — a
    // POS that lost its network still has to print the guest's slip.
    expect(new Set(retry.charges.map((c) => String(c._id))))
      .toEqual(new Set(first.charges.map((c) => String(c._id))));
    expect(retry.walletBalance).toBe(5500);
    // The replay lookup is scoped to this event, so a reused id elsewhere can
    // never be handed back as this table's charges.
    expect(retry.charges.every((c) => String(c.eventId) === String(EVENT))).toBe(true);
  });

  // FINDING 1. The lines are read and priced OUTSIDE the transaction, so a
  // colleague's addItem can commit in that window. Driven deterministically by
  // hooking mongoose.startSession — the last thing settle does before opening
  // its transaction, i.e. exactly the moment when everything has been priced
  // and nothing has been written. A racing test would be worse than none.
  it('refuses rather than charging a stale total when another waiter adds a round mid-settle', async () => {
    const { table, stallB, productB } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);

    const realStartSession = mongoose.startSession.bind(mongoose);
    const spy = jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      // Priced at 4500; this lands before the flip and makes it 6000.
      await TableService.addItem({
        tableId: String(table._id), eventId: String(EVENT),
        merchantId: stallB, productId: productB, qty: 1, addedBy: String(WAITER),
      });
      return realStartSession(...args);
    });

    try {
      await expect(TableService.settle(settleArgs(table, 's1')))
        .rejects.toThrow(/table changed during settlement/i);
    } finally {
      spy.mockRestore();
    }

    // Nothing charged, nothing posted, and the tab still carries BOTH rounds.
    expect((await Wallet.findById(wallet._id))!.balance).toBe(10000);
    expect(await MerchantCharge.countDocuments({})).toBe(0);
    expect(await LedgerEntry.countDocuments({ refType: 'table_settlement' })).toBe(0);
    const after = await Table.findById(table._id);
    expect(after!.status).toBe('open');
    expect(after!.subtotal).toBe(6000);
    expect(after!.items).toHaveLength(3);
  });

  // ROUND 2. The residual the subtotal guard could not close: a line removed at
  // one stall and an identically-priced one added at ANOTHER, inside the
  // pricing window. subtotal AND the line count both come out unchanged, so
  // only `revision` can see it — and without it the guest's total is right
  // while stall B is paid for a drink that was taken off and stall C is never
  // paid for the one that was served off its shelf.
  it('refuses an equal-value swap between stalls mid-settle, which leaves subtotal untouched', async () => {
    const { table, stallB } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);
    const stallC = await seedStall({ price: 1500, onHand: 10, name: 'Cider' });
    const lineB = table.items.find((l) => String(l.merchantId) === stallB)!;

    const realStartSession = mongoose.startSession.bind(mongoose);
    const spy = jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      await TableService.removeItem({
        tableId: String(table._id), eventId: String(EVENT),
        lineId: String(lineB._id), removedBy: String(WAITER),
      });
      await TableService.addItem({
        tableId: String(table._id), eventId: String(EVENT),
        merchantId: stallC.merchantId, productId: stallC.productId, qty: 1, addedBy: String(WAITER),
      });
      return realStartSession(...args);
    });

    try {
      await expect(TableService.settle(settleArgs(table, 's1')))
        .rejects.toThrow(/table changed during settlement/i);
    } finally {
      spy.mockRestore();
    }

    expect((await Wallet.findById(wallet._id))!.balance).toBe(10000);
    expect(await MerchantCharge.countDocuments({})).toBe(0);
    expect(await LedgerEntry.countDocuments({ refType: 'table_settlement' })).toBe(0);
    const after = await Table.findById(table._id);
    expect(after!.status).toBe('open');
    // The money figures are IDENTICAL to what was priced — this is exactly why
    // subtotal and the line count cannot catch this one.
    expect(after!.subtotal).toBe(table.subtotal);
    expect(after!.items).toHaveLength(table.items.length);
    // But the split moved: stall B is off the tab, stall C is on it.
    const stalls = new Set(after!.items.map((l) => String(l.merchantId)));
    expect(stalls.has(stallB)).toBe(false);
    expect(stalls.has(stallC.merchantId)).toBe(true);
  });

  // FINDING 2. Two settles issued with the SAME clientTxnId — a POS retry that
  // overlaps its own original, which is when the in-transaction replay path
  // runs. Both callers must be answered with the ONE settlement.
  it('answers BOTH callers of a concurrent same-id retry with the one settlement', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 10, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);
    const args = settleArgs(table, 'same');

    const results = await Promise.allSettled([TableService.settle(args), TableService.settle(args)]);

    const settled = results.filter((r) => r.status === 'fulfilled') as
      PromiseFulfilledResult<Awaited<ReturnType<typeof TableService.settle>>>[];
    expect(settled).toHaveLength(2);
    // Debited ONCE.
    expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
    expect(settled.every((r) => r.value.walletBalance === 5500)).toBe(true);
    // One settlement's worth of rows, and both callers see the same ones.
    expect(await MerchantCharge.countDocuments({})).toBe(2);
    const ids = settled.map((r) => new Set(r.value.charges.map((c) => String(c._id))));
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]!.size).toBe(2);
    const entries = await LedgerEntry.find({ refType: 'table_settlement', refId: String(table._id) });
    expect(entries).toHaveLength(4);
    expect(entries.reduce((t, e) => t + e.delta, 0)).toBe(0);
  });

  // FINDING 2, path C. The per-stall {merchantId, clientTxnId} index is the
  // last line of defence. Reached only when that id is already taken while the
  // table is still open — a cross-table id reuse — where replaying would hand
  // back ANOTHER table's charges. It must refuse, whole, with nothing written.
  it('writes nothing when a stall\'s settlement id is already taken', async () => {
    const { table, stallA } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);
    await MerchantCharge.create({
      merchantId: stallA, eventId: EVENT, walletId: wallet._id, bandUid: TAG,
      amount: 100, fee: 0, netAmount: 100, clientTxnId: `s1:${stallA}`,
      status: 'completed', staffName: 'Someone Else',
    });

    await expect(TableService.settle(settleArgs(table, 's1'))).rejects.toThrow();

    expect((await Wallet.findById(wallet._id))!.balance).toBe(10000);
    expect(await MerchantCharge.countDocuments({})).toBe(1); // only the pre-existing row
    expect(await LedgerEntry.countDocuments({ refType: 'table_settlement' })).toBe(0);
    expect((await Table.findById(table._id))!.status).toBe('open');
  });

  // FINDING 4. Same id, different band. Replaying success here would tell the
  // waiter THIS guest paid while the money came off the first guest's tag.
  it('refuses a retry that reuses the id for a DIFFERENT tag', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const paid = await fundedWallet(10000, TAG);
    const other = await fundedWallet(10000, '04b33c2d');
    await TableService.settle(settleArgs(table, 'same'));

    await expect(TableService.settle({ ...settleArgs(table, 'same'), bandUid: '04b33c2d' }))
      .rejects.toThrow(/different tag/i);

    expect((await Wallet.findById(paid._id))!.balance).toBe(5500);
    expect((await Wallet.findById(other._id))!.balance).toBe(10000);
    expect(await MerchantCharge.countDocuments({})).toBe(2);
  });

  it('refuses a settle under a DIFFERENT id once the table is settled', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    await fundedWallet(10000, TAG);
    await TableService.settle(settleArgs(table, 'first'));

    await expect(TableService.settle(settleArgs(table, 'second'))).rejects.toThrow(/already settled/i);
    expect(await MerchantCharge.countDocuments({})).toBe(2);
  });

  it('still pays a stall that was suspended after the drinks were served', async () => {
    // Suspension blocks NEW items, not money already owed. The goods went out.
    const { table, stallA } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);
    await Merchant.updateOne({ _id: stallA }, { $set: { status: 'suspended' } });

    const { charges } = await TableService.settle(settleArgs(table, 's1'));

    expect(charges).toHaveLength(2);
    expect(charges.find((c) => String(c.merchantId) === stallA)!.netAmount).toBe(3000);
    expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
  });

  it('bills the snapshot when the product was deleted mid-service', async () => {
    const { table, productA } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    const wallet = await fundedWallet(10000, TAG);
    await Product.deleteOne({ _id: productA });

    const { charges } = await TableService.settle(settleArgs(table, 's1'));

    expect((await Wallet.findById(wallet._id))!.balance).toBe(5500);
    // The line's own name/unitPrice, not the catalogue's — there is no
    // catalogue row left to read.
    const a = charges.find((c) => c.items?.some((i) => String(i.productId) === productA))!;
    expect(a.items![0]!.name).toBe('Beer');
    expect(a.items![0]!.unitPrice).toBe(3000);
  });

  it('records the waiter and their name on every stall\'s charge', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    await fundedWallet(10000, TAG);

    const { charges } = await TableService.settle(settleArgs(table, 's1'));

    for (const c of charges) {
      expect(String(c.waiterId)).toBe(String(WAITER));
      expect(c.staffName).toBe('Thabo');
      expect(c.merchantOperatorId).toBeUndefined();
      expect(c.bandUid).toBe(TAG);
    }
    const settled = await Table.findById(table._id);
    expect(settled!.settledBy).toBe(String(WAITER));
    expect(settled!.settleTxnId).toBe('s1');
  });

  it('refuses an empty table', async () => {
    const table = await TableService.open({ eventId: String(EVENT), label: '9', openedBy: String(WAITER) });
    await fundedWallet(10000, TAG);
    await expect(TableService.settle(settleArgs(table, 's1'))).rejects.toThrow(/nothing on this table/i);
  });

  it('refuses a tag with no wallet at this event', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });

    await expect(TableService.settle(settleArgs(table, 's1'))).rejects.toThrow(/no wallet/i);
    expect((await Table.findById(table._id))!.status).toBe('open');
  });

  it('will not settle a voided table', async () => {
    const { table } = await seedTwoStallTable({ a: 3000, b: 1500, commissionA: 0, commissionB: 0 });
    await fundedWallet(10000, TAG);
    await TableService.voidTable({ tableId: String(table._id), eventId: String(EVENT), reason: 'walked', voidedBy: String(WAITER) });

    await expect(TableService.settle(settleArgs(table, 's1'))).rejects.toThrow(/not open|already settled/i);
    expect(await MerchantCharge.countDocuments({})).toBe(0);
  });

  // A waiter's eventId comes from their own verified token, never from the
  // table id — so a table at another event must read exactly like a missing
  // one, and must certainly not be charged to this event's tag.
  it('will not settle a table belonging to a different event', async () => {
    await fundedWallet(10000, TAG);
    const foreign = await Table.create({
      eventId: new mongoose.Types.ObjectId(), label: 'F1', status: 'open',
      openedBy: 'w0', items: [], subtotal: 0,
    });

    await expect(TableService.settle(settleArgs(foreign, 's1'))).rejects.toThrow(/table not found/i);
    expect((await Table.findById(foreign._id))!.status).toBe('open');
  });
});
