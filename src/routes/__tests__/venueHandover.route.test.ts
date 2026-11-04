import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { addVenueProduct, seedVenue, seedVenueStall, seedVenueTill, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { EVENT, seedStall } from '@/__tests__/helpers/tables';
import { Table } from '@models/table.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { StockService } from '@services/stock.service';
import { MerchantPermission } from '@interfaces/merchant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function served() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const barTill = await seedVenueTill(venue, bar.merchantId, { fullName: 'Nomsa' });
  const kitchenTill = await seedVenueTill(venue, kitchen.merchantId, { fullName: 'Chef' });
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth)
    .send({ clientTxnId: 'r1', items: [{ ...bar, qty: 2 }, { ...kitchen, qty: 1 }] });
  const orderOf = (merchantId: string) => round.body.data.orders.find((o: { merchantId: string }) => o.merchantId === merchantId)._id as string;
  const lineOf = (name: string) => round.body.data.items.find((l: { name: string }) => l.name === name)._id as string;
  return { venue, bar, kitchen, waiter, barTill, kitchenTill, tableId, barOrder: orderOf(bar.merchantId), kitchenOrder: orderOf(kitchen.merchantId), beerLine: lineOf('Castle Lite'), burgerLine: lineOf('Burger') };
}
type Served = Awaited<ReturnType<typeof served>>;
const queue = (auth: string, status?: string) => request(app).get(`/api/merchant/orders${status ? `?status=${status}` : ''}`).set('Authorization', auth);
const handOut = (auth: string, tableId: string, orderId: string) => request(app).post(`/api/merchant/tables/${tableId}/orders/${orderId}/hand-out`).set('Authorization', auth).send({});
const accept = (auth: string, tableId: string, orderId: string) => request(app).post(`/api/waiter/tables/${tableId}/orders/${orderId}/accept`).set('Authorization', auth).send({});
const remove = (auth: string, tableId: string, lineId: string) => request(app).delete(`/api/waiter/tables/${tableId}/items/${lineId}`).set('Authorization', auth);

describe('the till queue', () => {
  it("shows a stall only its own orders, with the waiter's name and the lines to make", async () => {
    const s = await served();
    const res = await queue(s.barTill.auth, 'sent');
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([expect.objectContaining({
      tableId: s.tableId, tableLabel: '7', orderId: s.barOrder, status: 'sent', waiterName: 'Sipho',
      items: [{ name: 'Castle Lite', qty: 2, unitPrice: 2500 }], total: 5000,
    })]);
  });

  it('refuses an unknown status, an event till, and still refuses a venue till on the event table routes', async () => {
    const s = await served();
    const bad = await queue(s.barTill.auth, 'paid');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Unknown order status');
    const stall = await seedStall({ price: 100, onHand: 1 });
    const eventOperator = await MerchantOperator.create({ fullName: 'Op', merchantId: stall.merchantId, eventId: EVENT, loginCode: 'EVT001', pin: '111111' });
    const eventTill = `Bearer ${jwt.sign({ scope: 'merchant', merchantId: stall.merchantId, merchantOperatorId: String(eventOperator._id), operatorName: 'Op', eventId: String(EVENT), name: 'Bar', permissions: [MerchantPermission.CHARGE] }, JWT_SECRET)}`;
    const venueOnly = await queue(eventTill);
    expect(venueOnly.status).toBe(403);
    expect(venueOnly.body.message).toBe('That is a venue feature');
    const tables = await request(app).get('/api/merchant/tables').set('Authorization', s.barTill.auth);
    expect(tables.status).toBe(403);
    expect(tables.body.message).toBe('Venue tills hand out orders, not tables');
  });
});

describe('hand-out and accept', () => {
  it('walks an order sent → handed out → collected, stamping who did each', async () => {
    const s = await served();
    const out = await handOut(s.barTill.auth, s.tableId, s.barOrder);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ orderId: s.barOrder, status: 'handed_out', tableLabel: '7' });
    expect((await queue(s.barTill.auth, 'sent')).body.data.orders).toHaveLength(0);
    expect((await queue(s.barTill.auth, 'handed_out')).body.data.orders).toHaveLength(1);
    const got = await accept(s.waiter.auth, s.tableId, s.barOrder);
    expect(got.status).toBe(200);
    const order = got.body.data.orders.find((o: { _id: string }) => o._id === s.barOrder);
    expect(order).toMatchObject({ status: 'collected', handedOutBy: s.barTill.merchantOperatorId, acceptedBy: s.waiter.waiterId });
    expect(order.handedOutAt).toBeTruthy();
    expect(order.acceptedAt).toBeTruthy();
  });

  it('guards each step: no double hand-out, no accept before hand-out, no other stall', async () => {
    const s = await served();
    const early = await accept(s.waiter.auth, s.tableId, s.barOrder);
    expect(early.status).toBe(409);
    expect(early.body.message).toBe('that handover is sent, not handed_out');
    const wrongStall = await handOut(s.kitchenTill.auth, s.tableId, s.barOrder);
    expect(wrongStall.status).toBe(404);
    expect((await handOut(s.barTill.auth, s.tableId, s.barOrder)).status).toBe(200);
    const twice = await handOut(s.barTill.auth, s.tableId, s.barOrder);
    expect(twice.status).toBe(409);
    expect(twice.body.message).toBe('that handover is handed_out, not sent');
    const junk = await handOut(s.barTill.auth, 'junk', s.barOrder);
    expect(junk.status).toBe(404);
  });

  it("another venue's till and another waiter cannot move it", async () => {
    const s = await served();
    const elsewhere = await seedVenue();
    const otherStall = await seedVenueStall(elsewhere.venueId, { price: 100, onHand: 1 });
    const otherTill = await seedVenueTill(elsewhere, otherStall.merchantId);
    expect((await handOut(otherTill.auth, s.tableId, s.barOrder)).status).toBe(404);
    await handOut(s.barTill.auth, s.tableId, s.barOrder);
    const colleague = await seedVenueWaiter(s.venue);
    expect((await accept(colleague.auth, s.tableId, s.barOrder)).status).toBe(404);
    const stored = await Table.findById(s.tableId).lean();
    expect(stored?.orders?.find((o) => String(o._id) === s.barOrder)?.status).toBe('handed_out');
  });
});

describe('ids in the URL are case-insensitive', () => {
  it('hand-out and accept answer from the row they moved, and a repeat is a 409 not a 404', async () => {
    const s = await served();
    const table = s.tableId.toUpperCase();
    const order = s.barOrder.toUpperCase();
    const out = await handOut(s.barTill.auth, table, order);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ orderId: s.barOrder, status: 'handed_out', tableLabel: '7' });
    const twice = await handOut(s.barTill.auth, table, order);
    expect(twice.status).toBe(409);
    expect(twice.body.message).toBe('that handover is handed_out, not sent');
    expect((await accept(s.waiter.auth, table, order)).status).toBe(200);
    const again = await accept(s.waiter.auth, table, order);
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('that handover is collected, not handed_out');
  });

  it('a line is removed by an uppercase id too', async () => {
    const s = await served();
    const res = await remove(s.waiter.auth, s.tableId.toUpperCase(), s.beerLine.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((l: { name: string }) => l.name)).toEqual(['Burger']);
  });
});

describe('removing a line', () => {
  it('takes a line off while its round is still at the bar, and the stock goes back', async () => {
    const s = await served();
    const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
    expect(res.status).toBe(200);
    expect(res.body.data.subtotal).toBe(9000);
    expect(res.body.data.items.map((l: { name: string }) => l.name)).toEqual(['Burger']);
    // the bar's order had only that line, so the order is gone too
    expect(res.body.data.orders.map((o: { _id: string }) => o._id)).toEqual([s.kitchenOrder]);
    expect(await StockService.getOnHand(s.bar.merchantId, s.bar.productId)).toBe(10);
    expect((await queue(s.barTill.auth, 'sent')).body.data.orders).toHaveLength(0);
  });

  it('refuses once the round has been handed out — it was served', async () => {
    const s = await served();
    await handOut(s.barTill.auth, s.tableId, s.barOrder);
    const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('that round has already been handed out');
    expect((await Table.findById(s.tableId))!.subtotal).toBe(14000);
    expect(await StockService.getOnHand(s.bar.merchantId, s.bar.productId)).toBe(8);
  });

  it('refuses a line that is partly paid', async () => {
    const s = await served();
    await Table.updateOne({ _id: s.tableId, 'items._id': s.beerLine }, { $set: { 'items.$.paidQty': 1, paidTotal: 2500 } });
    const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('that item is already paid for');
  });

  it('answers 404 for a line that is not on the table', async () => {
    const s = await served();
    const res = await remove(s.waiter.auth, s.tableId, '000000000000000000000001');
    expect(res.status).toBe(404);
  });
  it('takes one of two lines at the same stall off and keeps the order, holding only the other', async () => {
    const venue = await seedVenue();
    const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
    const cider = await addVenueProduct(venue.venueId, bar.merchantId, { name: 'Savanna', price: 3000, onHand: 10 });
    const waiter = await seedVenueWaiter(venue);
    const till = await seedVenueTill(venue, bar.merchantId);
    const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '3' })).body.data._id as string;
    const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth)
      .send({ clientTxnId: 'two-lines', items: [{ ...bar, qty: 2 }, { merchantId: bar.merchantId, productId: cider, qty: 1 }] });
    expect(round.body.data.orders).toHaveLength(1);
    expect(round.body.data.orders[0].lineIds).toHaveLength(2);
    const lineOf = (name: string) => round.body.data.items.find((l: { name: string }) => l.name === name)._id as string;

    const res = await remove(waiter.auth, tableId, lineOf('Castle Lite'));
    expect(res.status).toBe(200);
    expect(res.body.data.subtotal).toBe(3000);
    expect(res.body.data.orders).toEqual([expect.objectContaining({ _id: round.body.data.orders[0]._id, status: 'sent', lineIds: [lineOf('Savanna')] })]);
    const stored = await Table.findById(tableId).lean();
    expect(stored?.orders?.[0]?.lineIds.map(String)).toEqual([lineOf('Savanna')]);
    expect((await queue(till.auth, 'sent')).body.data.orders).toEqual([expect.objectContaining({
      orderId: round.body.data.orders[0]._id, items: [{ name: 'Savanna', qty: 1, unitPrice: 3000 }], total: 3000,
    })]);
    expect(await StockService.getOnHand(bar.merchantId, bar.productId)).toBe(10);
    expect(await StockService.getOnHand(bar.merchantId, cider)).toBe(9);
  });

  // The pre-read says "fine"; the guarded update is what stops a change that
  // landed between that read and the write. Make the read stale so ONLY the
  // update's own filter can refuse.
  it.each([
    ['the round was handed out', (s: Served) => Table.updateOne({ _id: s.tableId, 'orders._id': s.barOrder }, { $set: { 'orders.$.status': 'handed_out' } })],
    ['the line was partly paid', (s: Served) => Table.updateOne({ _id: s.tableId, 'items._id': s.beerLine }, { $set: { 'items.$.paidQty': 1, paidTotal: 2500 } })],
    ['the table was settled', (s: Served) => Table.updateOne({ _id: s.tableId }, { $set: { status: 'settled' } })],
    // 14000 − the 5000 beers = 9000: a payment of 9000 (no lines) leaves nothing for the table to close on.
    ['a payment left nothing to pay once the line is gone', (s: Served) => Table.updateOne({ _id: s.tableId }, { $inc: { paidTotal: 9000 } })],
  ])('the update itself refuses when %s after the read, and nothing moves', async (_what, change) => {
    const s = await served();
    const realFindOne = Table.findOne.bind(Table) as (...args: unknown[]) => any;
    let moved = false;
    // removeLine's pre-read is the one findOne without a projection (mayWorkTable's has one).
    const spy = jest.spyOn(Table, 'findOne').mockImplementation(((filter: unknown, projection?: unknown) => {
      if (projection !== undefined || moved) return realFindOne(filter, projection);
      return (async () => {
        const stale = await realFindOne(filter);
        await change(s);
        moved = true;
        return stale;
      })();
    }) as never);
    try {
      const res = await remove(s.waiter.auth, s.tableId, s.beerLine);
      expect(moved).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('that item can no longer be removed — refresh the table');
    } finally {
      spy.mockRestore();
    }
    const stored = await Table.findById(s.tableId).lean();
    expect(stored?.subtotal).toBe(14000);
    expect(stored?.items).toHaveLength(2);
    expect(stored?.orders).toHaveLength(2);
    expect(await StockService.getOnHand(s.bar.merchantId, s.bar.productId)).toBe(8);
  });
});
