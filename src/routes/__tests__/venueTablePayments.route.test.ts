import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedEventWaiter, seedVenue, seedVenueStall, seedVenueWaiter, venueDashboardAuth } from '@/__tests__/helpers/venueFloor';
import { Table } from '@models/table.model';
import { Venue } from '@models/venue.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { VenuePayment } from '@models/venuePayment.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { StockService } from '@services/stock.service';
import { VenueTableService, TablePayment } from '@services/venueTable.service';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** Table 7: 2 beers (E25 each, Main Bar) + 1 burger (E90, Kitchen) = 14000. */
async function bill() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth)
    .send({ clientTxnId: 'r1', items: [{ ...bar, qty: 2 }, { ...kitchen, qty: 1 }] });
  const beerLine = round.body.data.items.find((l: { name: string }) => l.name === 'Castle Lite')._id as string;
  const burgerLine = round.body.data.items.find((l: { name: string }) => l.name === 'Burger')._id as string;
  const pay = (body: unknown, auth = waiter.auth, id = tableId) => request(app).post(`/api/waiter/tables/${id}/payments`).set('Authorization', auth).send(body as object);
  const remove = (lineId: string) => request(app).delete(`/api/waiter/tables/${tableId}/items/${lineId}`).set('Authorization', waiter.auth);
  return { venue, bar, kitchen, waiter, tableId, beerLine, burgerLine, pay, remove };
}
const cash = (amount: number, tip?: number) => ({ method: 'cash', amount, ...(tip ? { tip } : {}) });
const card = (amount: number, tip?: number, reference?: string) => ({ method: 'card', amount, ...(tip ? { tip } : {}), ...(reference ? { reference } : {}) });

describe('paying a venue table', () => {
  it('one payment — cash and card, with a card tip — closes the table and writes each stall its takings', async () => {
    const b = await bill();
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(5000), card(9000, 1000, '0192')] });
    expect(res.status).toBe(200);
    expect(res.body.data.closed).toBe(true);
    expect(res.body.data.table).toMatchObject({ status: 'settled', subtotal: 14000, paidTotal: 14000 });
    expect(res.body.data.payment).toMatchObject({ source: 'table', tableLabel: '7', applied: 14000, tips: 1000, staffName: 'Sipho', takenByType: 'Waiter' });
    expect(res.body.data.payment.tenders).toEqual([{ method: 'cash', amount: 5000, tip: 0 }, { method: 'card', amount: 9000, tip: 1000, reference: '0192' }]);

    const charges = await MerchantCharge.find({ venueId: b.venue.venueId }).lean();
    expect(charges).toHaveLength(2);
    const barCharge = charges.find((c) => String(c.merchantId) === b.bar.merchantId)!;
    expect(barCharge).toMatchObject({ amount: 5000, fee: 0, netAmount: 5000, staffName: 'Sipho', clientTxnId: `p1:${b.bar.merchantId}`, status: 'completed' });
    expect(String(barCharge.waiterId)).toBe(b.waiter.waiterId);
    expect(barCharge.walletId).toBeUndefined();
    expect(barCharge.eventId).toBeUndefined();
    expect(barCharge.items).toEqual([expect.objectContaining({ name: 'Castle Lite', qty: 2, unitPrice: 2500, lineTotal: 5000 })]);
    // tips never reach a stall's takings
    expect(charges.reduce((sum, c) => sum + c.amount, 0)).toBe(14000);
    // the table number is free again
    expect((await request(app).post('/api/waiter/tables').set('Authorization', b.waiter.auth).send({ label: '7' })).status).toBe(201);
  });

  it('a part payment leaves the table open; the rest closes it and takings are written once', async () => {
    const b = await bill();
    const first = await b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ closed: false, table: { status: 'open', paidTotal: 4000 } });
    expect(await MerchantCharge.countDocuments()).toBe(0);
    const rest = await b.pay({ clientTxnId: 'p2', tenders: [card(10000)] });
    expect(rest.body.data).toMatchObject({ closed: true, table: { status: 'settled', paidTotal: 14000 } });
    expect(await MerchantCharge.countDocuments()).toBe(2);
    expect(await VenuePayment.countDocuments({ tableId: b.tableId })).toBe(2);
  });

  it("pays for a guest's items and marks them paid", async () => {
    const b = await bill();
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(2500)], lines: [{ lineId: b.beerLine, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.payment.lines).toEqual([{ lineId: b.beerLine, qty: 1 }]);
    expect(res.body.data.table.items.find((l: { _id: string }) => l._id === b.beerLine).paidQty).toBe(1);
    expect(res.body.data.table.paidTotal).toBe(2500);

    const tooMany = await b.pay({ clientTxnId: 'p2', tenders: [cash(5000)], lines: [{ lineId: b.beerLine, qty: 2 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toBe('only 1 of Castle Lite left to pay');
    expect(JSON.parse(tooMany.body.error)).toMatchObject({ reason: 'line_overpaid', unpaid: 1 });

    const wrongTotal = await b.pay({ clientTxnId: 'p3', tenders: [cash(2000)], lines: [{ lineId: b.beerLine, qty: 1 }] });
    expect(wrongTotal.status).toBe(400);
    expect(wrongTotal.body.message).toBe('the payment must equal the selected items');

    const unknownLine = await b.pay({ clientTxnId: 'p4', tenders: [cash(2500)], lines: [{ lineId: '000000000000000000000001', qty: 1 }] });
    expect(unknownLine.status).toBe(400);
    expect(unknownLine.body.message).toBe('line not found on this table');
    expect(JSON.parse(unknownLine.body.error)).toMatchObject({ reason: 'line_not_found', lineId: '000000000000000000000001' });
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(2500);
  });

  it('a line id sent in UPPER-CASE is the same line: accepted, and marked paid', async () => {
    const b = await bill();
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(2500)], lines: [{ lineId: b.beerLine.toUpperCase(), qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.payment.lines).toEqual([{ lineId: b.beerLine, qty: 1 }]);
    expect(res.body.data.table.items.find((l: { _id: string }) => l._id === b.beerLine).paidQty).toBe(1);
    expect(res.body.data.table.paidTotal).toBe(2500);
  });

  it('refuses more than the balance, and a payment that takes nothing off the bill', async () => {
    const b = await bill();
    const over = await b.pay({ clientTxnId: 'p1', tenders: [cash(15000)] });
    expect(over.status).toBe(400);
    expect(over.body.message).toBe('that is more than the balance on this table');
    expect(JSON.parse(over.body.error)).toMatchObject({ reason: 'exceeds_balance', outstanding: 14000 });
    const nothing = await b.pay({ clientTxnId: 'p2', tenders: [cash(0, 500)] });
    expect(nothing.status).toBe(400);
    expect(nothing.body.message).toBe('a payment must take something off the bill');
    for (const body of [{ tenders: [cash(100)] }, { clientTxnId: 'p3', tenders: [] }, { clientTxnId: 'p3', tenders: [{ method: 'momo', amount: 100 }] }, { clientTxnId: 'p3', tenders: [cash(-1)] }]) {
      expect((await b.pay(body)).status).toBe(400);
    }
    expect(await VenuePayment.countDocuments()).toBe(0);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(0);
  });

  it('a retried payment is taken once; the same id for a different amount is refused', async () => {
    const b = await bill();
    const body = { clientTxnId: 'p1', tenders: [cash(4000)] };
    const first = await b.pay(body);
    const again = await b.pay(body);
    expect(again.status).toBe(200);
    expect(again.body.data.payment._id).toBe(first.body.data.payment._id);
    expect(again.body.data.table.paidTotal).toBe(4000);
    expect(await VenuePayment.countDocuments()).toBe(1);
    const different = await b.pay({ clientTxnId: 'p1', tenders: [cash(5000)] });
    expect(different.status).toBe(409);
    expect(JSON.parse(different.body.error)).toMatchObject({ reason: 'idempotency_mismatch' });
  });

  it('two devices paying the whole balance at once: one wins, the table closes once', async () => {
    const b = await bill();
    const lead = await seedVenueWaiter(b.venue, { fullName: 'Lead', grants: [OperatorGrant.SETTLE_TABLES, OperatorGrant.MANAGE_ALL_TABLES] });
    const [x, y] = await Promise.all([
      b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] }),
      b.pay({ clientTxnId: 'p2', tenders: [card(14000)] }, lead.auth),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(['the bill changed — check the balance', 'table is already settled']).toContain(loser.body.message);
    expect(await VenuePayment.countDocuments()).toBe(1);
    expect(await MerchantCharge.countDocuments()).toBe(2);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(14000);
  });

  it('a balance that moved between reading the bill and paying it is refused: the bill changed', async () => {
    const b = await bill();
    const real = Table.findOneAndUpdate.bind(Table);
    // Another device's payment lands after this one read the bill, and before it writes.
    const spy = jest.spyOn(Table, 'findOneAndUpdate').mockImplementationOnce(((...args: unknown[]) =>
      Table.updateOne({ _id: b.tableId }, { $inc: { paidTotal: 1000 } }).then(() => (real as any)(...args))) as any);
    try {
      const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('the bill changed — check the balance');
      expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'bill_changed' });
    } finally {
      spy.mockRestore();
    }
    expect(await VenuePayment.countDocuments()).toBe(0);
    expect((await Table.findById(b.tableId))!.paidTotal).toBe(1000);
  });

  it('a round added after the bill was quoted grows the balance — the old total no longer closes it', async () => {
    const b = await bill();
    await request(app).post(`/api/waiter/tables/${b.tableId}/orders`).set('Authorization', b.waiter.auth).send({ clientTxnId: 'r2', items: [{ ...b.bar, qty: 1 }] });
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ closed: false, table: { subtotal: 16500, paidTotal: 14000, status: 'open' } });
    const rest = await b.pay({ clientTxnId: 'p2', tenders: [cash(2500)] });
    expect(rest.body.data.closed).toBe(true);
    expect((await MerchantCharge.findOne({ merchantId: b.bar.merchantId }).lean())!.amount).toBe(7500);
  });

  it('needs the take-payment switch; refuses a closed table and another waiter', async () => {
    const b = await bill();
    const server = await seedVenueWaiter(b.venue, { fullName: 'Server', grants: [] });
    const noGrant = await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] }, server.auth);
    expect(noGrant.status).toBe(403);
    expect(noGrant.body.message).toBe('Permission required: waiter:settle_tables');
    const colleague = await seedVenueWaiter(b.venue);
    expect((await b.pay({ clientTxnId: 'p2', tenders: [cash(14000)] }, colleague.auth)).status).toBe(404);
    expect(await VenuePayment.countDocuments()).toBe(0);
    await b.pay({ clientTxnId: 'p3', tenders: [cash(14000)] });
    const closed = await b.pay({ clientTxnId: 'p4', tenders: [cash(100)] });
    expect(closed.status).toBe(409);
    expect(closed.body.message).toBe('table is already settled');
  });

  it('once the table is paid, the stock board shows what was sold', async () => {
    const b = await bill();
    await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] });
    const board = await request(app).get('/api/tickets/venue/stock/board').set('Authorization', await venueDashboardAuth(b.venue));
    expect(board.status).toBe(200);
    expect(board.body.data.byProduct.find((r: { productId: string }) => r.productId === b.bar.productId)).toMatchObject({ unitsSold: 2, revenue: 5000, totalOnHand: 8 });
  });
});

describe('paying a venue table — retries, removals and the races the guard rests on', () => {
  /** A raw look at a table: the state the money moved it to. */
  const stored = async (tableId: string) => (await Table.findById(tableId).lean())!;

  it('a retry that races its original is replayed, not refused: the original commits just before the retry reads the bill', async () => {
    const b = await bill();
    const realFindOne = Table.findOne.bind(Table) as (...args: unknown[]) => any;
    let fired = false;
    let original: TablePayment | undefined;
    // pay's own table read is the one findOne without a projection (mayWorkTable's has one).
    const spy = jest.spyOn(Table, 'findOne').mockImplementation(((filter: unknown, projection?: unknown) => {
      if (projection !== undefined || fired) return realFindOne(filter, projection);
      fired = true;
      return (async () => {
        original = await VenueTableService.pay({
          venueId: b.venue.venueId, tableId: b.tableId, clientTxnId: 'p1', tenders: [{ method: 'cash', amount: 14000 }],
          takenBy: b.waiter.waiterId, staffName: 'Sipho',
        });
        return realFindOne(filter);
      })();
    }) as never);
    let res: request.Response;
    try {
      res = await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] });
      expect(fired).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(res.body.data.payment._id).toBe(String(original!.payment._id));
    expect(res.body.data.closed).toBe(true);
    expect(await VenuePayment.countDocuments({ tableId: b.tableId })).toBe(1);
    expect(await MerchantCharge.countDocuments()).toBe(2);
    expect((await stored(b.tableId)).paidTotal).toBe(14000);
  });

  it('a retried CLOSING payment answers with the original and writes nothing more', async () => {
    const b = await bill();
    const body = { clientTxnId: 'p1', tenders: [cash(14000)] };
    const first = await b.pay(body);
    const again = await b.pay(body);
    expect(again.status).toBe(200);
    expect(again.body.data.payment._id).toBe(first.body.data.payment._id);
    expect(again.body.data.closed).toBe(true);
    expect(await VenuePayment.countDocuments()).toBe(1);
    expect(await MerchantCharge.countDocuments()).toBe(2);
  });

  it('a replayed PART payment still says it did not close the table, even after a later payment did', async () => {
    const b = await bill();
    const first = await b.pay({ clientTxnId: 'pA', tenders: [cash(4000)] });
    const closing = await b.pay({ clientTxnId: 'pB', tenders: [cash(10000)] });
    expect(closing.body.data.closed).toBe(true);
    const retry = await b.pay({ clientTxnId: 'pA', tenders: [cash(4000)] });
    expect(retry.status).toBe(200);
    expect(retry.body.data.payment._id).toBe(first.body.data.payment._id);
    expect(retry.body.data.closed).toBe(false);
    expect(await VenuePayment.countDocuments()).toBe(2);
  });

  it('the same payment id on a DIFFERENT table is refused', async () => {
    const b = await bill();
    await b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] });
    const other = (await request(app).post('/api/waiter/tables').set('Authorization', b.waiter.auth).send({ label: '8' })).body.data._id as string;
    const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] }, b.waiter.auth, other);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('that payment id was already used for a different payment');
    expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'idempotency_mismatch' });
    expect(await VenuePayment.countDocuments()).toBe(1);
    expect((await stored(other)).paidTotal).toBe(0);
  });

  it('refuses an event waiter, another venue\'s table, a voided table and a suspended venue — and writes nothing', async () => {
    const b = await bill();
    const eventWaiter = await seedEventWaiter({ grants: [OperatorGrant.SETTLE_TABLES] });
    const kind = await b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] }, eventWaiter.auth);
    expect(kind.status).toBe(403);
    expect(kind.body.message).toBe('That is a venue feature');

    const elsewhere = await seedVenueWaiter(await seedVenue(), { fullName: 'Other' });
    const foreign = await b.pay({ clientTxnId: 'p2', tenders: [cash(14000)] }, elsewhere.auth);
    expect(foreign.status).toBe(404);
    expect(foreign.body.message).toBe('Table not found');

    await Table.updateOne({ _id: b.tableId }, { $set: { status: 'voided' } });
    const voided = await b.pay({ clientTxnId: 'p3', tenders: [cash(14000)] });
    expect(voided.status).toBe(409);
    expect(voided.body.message).toBe('table is not open (status: voided)');
    await Table.updateOne({ _id: b.tableId }, { $set: { status: 'open' } });

    await Venue.updateOne({ _id: b.venue.venueId }, { $set: { status: 'suspended' } });
    const suspended = await b.pay({ clientTxnId: 'p4', tenders: [cash(14000)] });
    expect(suspended.status).toBe(401);
    expect(suspended.body.message).toBe('Venue trading is suspended');

    expect(await VenuePayment.countDocuments()).toBe(0);
    expect(await MerchantCharge.countDocuments()).toBe(0);
    expect((await stored(b.tableId)).paidTotal).toBe(0);
  });

  it('a table whose subtotal is not its lines is NOT closed: the stall takings must add up to the bill', async () => {
    const b = await bill();
    await Table.updateOne({ _id: b.tableId }, { $set: { subtotal: 15000 } });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await b.pay({ clientTxnId: 'p1', tenders: [cash(15000)] });
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('stall takings (14000) do not add up to the bill (15000)');
    } finally {
      quiet.mockRestore();
    }
    expect(await VenuePayment.countDocuments()).toBe(0);
    expect(await MerchantCharge.countDocuments()).toBe(0);
    expect(await stored(b.tableId)).toMatchObject({ status: 'open', paidTotal: 0 });
  });

  describe('taking a line off a part-paid bill', () => {
    it('is refused when it would leave nothing to pay — nothing moves', async () => {
      const b = await bill();
      expect((await b.pay({ clientTxnId: 'p1', tenders: [cash(5000)] })).status).toBe(200);
      // 14000 − 9000 = 5000, exactly what is already paid: no payment could ever close it.
      const res = await b.remove(b.burgerLine);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('part of this bill is paid — that item can no longer be removed');
      const t = await stored(b.tableId);
      expect(t).toMatchObject({ status: 'open', subtotal: 14000, paidTotal: 5000 });
      expect(t.items).toHaveLength(2);
      expect(t.orders).toHaveLength(2);
      expect(await StockService.getOnHand(b.kitchen.merchantId, b.kitchen.productId)).toBe(2);
    });

    it('is allowed while a balance remains, and the rest of the bill then closes on the NEW subtotal', async () => {
      const b = await bill();
      await b.pay({ clientTxnId: 'p1', tenders: [cash(5000)] });
      // 14000 − 5000 (the beers) = 9000 > 5000 paid.
      const res = await b.remove(b.beerLine);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ subtotal: 9000, paidTotal: 5000 });
      expect(await StockService.getOnHand(b.bar.merchantId, b.bar.productId)).toBe(10);

      const rest = await b.pay({ clientTxnId: 'p2', tenders: [card(4000)] });
      expect(rest.status).toBe(200);
      expect(rest.body.data).toMatchObject({ closed: true, table: { status: 'settled', subtotal: 9000, paidTotal: 9000 } });
      const charges = await MerchantCharge.find().lean();
      expect(charges.map((c) => c.amount)).toEqual([9000]);
      expect(String(charges[0]!.merchantId)).toBe(b.kitchen.merchantId);
    });

    it('is still allowed on an unpaid table, down to the last line', async () => {
      const b = await bill();
      expect((await b.remove(b.beerLine)).status).toBe(200);
      const last = await b.remove(b.burgerLine);
      expect(last.status).toBe(200);
      expect(last.body.data).toMatchObject({ subtotal: 0, items: [] });
    });
  });

  describe('the guard on the payment: the bill exactly as it was read', () => {
    /** Run `during` after pay has read the bill and before its guarded write lands. */
    async function inWindow<T>(during: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
      const real = Table.findOneAndUpdate.bind(Table);
      const spy = jest.spyOn(Table, 'findOneAndUpdate').mockImplementationOnce(((...args: unknown[]) =>
        during().then(() => (real as any)(...args))) as any);
      try {
        return await run();
      } finally {
        spy.mockRestore();
      }
    }

    it('a ROUND that lands in the window refuses the payment: the bill changed', async () => {
      const b = await bill();
      const res = await inWindow(
        () => VenueTableService.sendOrder({ venueId: b.venue.venueId, tableId: b.tableId, clientTxnId: 'r2', items: [{ ...b.bar, qty: 1 }], sentBy: b.waiter.waiterId }),
        // The old total — exactly what closed the table before the round.
        () => b.pay({ clientTxnId: 'p1', tenders: [cash(14000)] }),
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('the bill changed — check the balance');
      expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'bill_changed' });
      expect(await VenuePayment.countDocuments()).toBe(0);
      expect(await MerchantCharge.countDocuments()).toBe(0);
      expect(await stored(b.tableId)).toMatchObject({ status: 'open', subtotal: 16500, paidTotal: 0 });
    });

    it('a payment of the SAME clientTxnId that commits in the window is handed back, and this request adds nothing', async () => {
      const b = await bill();
      let injected: { _id: unknown } | undefined;
      const res = await inWindow(async () => {
        // What the original attempt left behind: its payment row and the money on the table.
        injected = await VenuePayment.create({
          venueId: b.venue.venueId, source: 'table', tableId: b.tableId, tableLabel: '7', merchantIds: [b.bar.merchantId, b.kitchen.merchantId],
          clientTxnId: 'p1', tenders: [{ method: 'cash', amount: 4000, tip: 0 }], applied: 4000, tips: 0,
          takenBy: b.waiter.waiterId, takenByType: 'Waiter', staffName: 'Sipho', at: new Date(),
        });
        await Table.updateOne({ _id: b.tableId }, { $inc: { paidTotal: 4000 } });
      }, () => b.pay({ clientTxnId: 'p1', tenders: [cash(4000)] }));
      expect(res.status).toBe(200);
      expect(res.body.data.payment._id).toBe(String(injected!._id));
      expect(res.body.data).toMatchObject({ closed: false, table: { status: 'open', paidTotal: 4000 } });
      expect(await VenuePayment.countDocuments()).toBe(1);
      expect((await stored(b.tableId)).paidTotal).toBe(4000);
    });
  });
});
