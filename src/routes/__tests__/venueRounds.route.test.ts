import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { addVenueProduct, lowStockNotices, seedVenue, seedVenueStall, seedVenueWaiter, setLowStockThreshold } from '@/__tests__/helpers/venueFloor';
import { seedStall } from '@/__tests__/helpers/tables';
import { Table } from '@models/table.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockService } from '@services/stock.service';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function floor() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const send = (body: unknown, auth = waiter.auth, id = tableId) => request(app).post(`/api/waiter/tables/${id}/orders`).set('Authorization', auth).send(body as object);
  return { venue, bar, kitchen, waiter, tableId, send };
}
const onHand = (s: { merchantId: string; productId: string }) => StockService.getOnHand(s.merchantId, s.productId);

describe('venue rounds', () => {
  it('sends one order per stall, takes the stock, and adds to the bill', async () => {
    const f = await floor();
    const res = await f.send({ clientTxnId: 'r1', items: [
      { ...f.bar, qty: 2 }, { ...f.kitchen, qty: 1 }, { ...f.bar, qty: 1 },
    ] });
    expect(res.status).toBe(200);
    const t = res.body.data;
    expect(t.subtotal).toBe(3 * 2500 + 9000);
    expect(t.orders).toHaveLength(2);
    expect(t.orders.every((o: { status: string; clientTxnId: string }) => o.status === 'sent' && o.clientTxnId === 'r1')).toBe(true);
    expect(t.items).toHaveLength(2);
    const beer = t.items.find((l: { name: string }) => l.name === 'Castle Lite');
    expect(beer).toMatchObject({ qty: 3, unitPrice: 2500, paidQty: 0, merchantName: 'Main Bar' });
    const barOrder = t.orders.find((o: { merchantId: string }) => o.merchantId === f.bar.merchantId);
    expect(beer.orderId).toBe(barOrder._id);
    expect(barOrder.lineIds).toEqual([beer._id]);
    expect(await onHand(f.bar)).toBe(7);
    expect(await onHand(f.kitchen)).toBe(2);
    const sale = await StockMovement.findOne({ productId: f.bar.productId, reason: 'sale' }).lean();
    expect(sale).toMatchObject({ delta: -3, refType: 'table_order', refId: barOrder._id, byType: 'Waiter', by: f.waiter.waiterId });
    expect(String(sale?.venueId)).toBe(f.venue.venueId);
  });

  it('a retried round is sent once', async () => {
    const f = await floor();
    const body = { clientTxnId: 'r1', items: [{ ...f.bar, qty: 2 }] };
    const first = await f.send(body);
    const again = await f.send(body);
    expect(again.status).toBe(200);
    expect(again.body.data.orders).toHaveLength(1);
    expect(again.body.data.subtotal).toBe(first.body.data.subtotal);
    expect(await onHand(f.bar)).toBe(8);
  });

  it('a second round adds to the same bill', async () => {
    const f = await floor();
    await f.send({ clientTxnId: 'r1', items: [{ ...f.bar, qty: 1 }] });
    const res = await f.send({ clientTxnId: 'r2', items: [{ ...f.bar, qty: 2 }] });
    expect(res.body.data.orders).toHaveLength(2);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.subtotal).toBe(7500);
  });

  it('ids sent in UPPER-CASE are the same ids: the round is sent once, stock moves once', async () => {
    const f = await floor();
    const upper = (s: { merchantId: string; productId: string }) => ({ merchantId: s.merchantId.toUpperCase(), productId: s.productId.toUpperCase() });
    const res = await f.send({ clientTxnId: 'r1', items: [{ ...upper(f.bar), qty: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ name: 'Castle Lite', qty: 2, merchantName: 'Main Bar' });
    expect(res.body.data.subtotal).toBe(5000);
    expect(await onHand(f.bar)).toBe(8);
    expect(await StockMovement.countDocuments({ productId: f.bar.productId, reason: 'sale' })).toBe(1);
  });

  it('one item out of stock rolls the whole round back, and names it', async () => {
    const f = await floor();
    const res = await f.send({ clientTxnId: 'r1', items: [{ ...f.bar, qty: 2 }, { ...f.kitchen, qty: 4 }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Out of stock: Burger');
    expect(JSON.parse(res.body.error)).toMatchObject({ reason: 'insufficient_stock', productId: f.kitchen.productId, name: 'Burger', available: 3 });
    const stored = await Table.findById(f.tableId).lean();
    expect(stored?.items).toHaveLength(0);
    expect(stored?.orders).toHaveLength(0);
    expect(stored?.subtotal).toBe(0);
    expect(await onHand(f.bar)).toBe(10);
    expect(await onHand(f.kitchen)).toBe(3);
  });

  it("refuses another venue's or an event's stall and product, and a product the stall does not stock", async () => {
    const f = await floor();
    const other = await seedVenueStall((await seedVenue()).venueId, { price: 100, onHand: 5 });
    const eventStall = await seedStall({ price: 100, onHand: 5 });
    const unstocked = await addVenueProduct(f.venue.venueId, f.kitchen.merchantId, { name: 'Wine', price: 4000, onHand: 2 });
    for (const items of [[{ ...other, qty: 1 }], [{ ...eventStall, qty: 1 }], [{ merchantId: f.bar.merchantId, productId: other.productId, qty: 1 }]]) {
      const res = await f.send({ clientTxnId: `x${Math.random()}`, items });
      expect(res.status).toBe(400);
    }
    const wrongStall = await f.send({ clientTxnId: 'x9', items: [{ merchantId: f.bar.merchantId, productId: unstocked, qty: 1 }] });
    expect(wrongStall.status).toBe(400);
    expect(wrongStall.body.message).toBe('Wine is not sold at that stall');
    expect((await Table.findById(f.tableId))!.subtotal).toBe(0);
    expect(await onHand(other)).toBe(5);
  });

  it('validates the round', async () => {
    const f = await floor();
    for (const body of [
      { items: [{ ...f.bar, qty: 1 }] },
      { clientTxnId: 'r1', items: [] },
      { clientTxnId: 'r1', items: [{ ...f.bar, qty: 0 }] },
      { clientTxnId: 'r1', items: [{ ...f.bar, qty: 1001 }] },
      { clientTxnId: 'r1', items: [{ merchantId: 'junk', productId: f.bar.productId, qty: 1 }] },
    ]) {
      expect((await f.send(body)).status).toBe(400);
    }
    expect(await onHand(f.bar)).toBe(10);
  });

  it("refuses another waiter's table and a closed table", async () => {
    const f = await floor();
    const colleague = await seedVenueWaiter(f.venue);
    const notMine = await f.send({ clientTxnId: 'r1', items: [{ ...f.bar, qty: 1 }] }, colleague.auth);
    expect(notMine.status).toBe(404);
    await Table.updateOne({ _id: f.tableId }, { $set: { status: 'settled' } });
    const closed = await f.send({ clientTxnId: 'r2', items: [{ ...f.bar, qty: 1 }] });
    expect(closed.status).toBe(409);
    expect(await onHand(f.bar)).toBe(10);
  });
});

describe('a round and the low-stock alert', () => {
  it("alerts the venue owner once for each stall whose stock the round took to its threshold", async () => {
    const f = await floor();
    await setLowStockThreshold(f.bar.merchantId, f.bar.productId, 8);
    await setLowStockThreshold(f.kitchen.merchantId, f.kitchen.productId, 2);
    const round = { clientTxnId: 'r1', items: [{ ...f.bar, qty: 2 }, { ...f.kitchen, qty: 1 }] };
    expect((await f.send(round)).status).toBe(200); // bar 10 -> 8, kitchen 3 -> 2: both cross
    const notices = await lowStockNotices(f.venue.vendorId);
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ merchantId: f.bar.merchantId, productId: f.bar.productId, onHand: 8, threshold: 8 }),
      expect.objectContaining({ merchantId: f.kitchen.merchantId, productId: f.kitchen.productId, onHand: 2, threshold: 2 }),
    ]));
    // the retry takes nothing more off the shelf and alerts nobody again
    expect((await f.send(round)).status).toBe(200);
    expect(await lowStockNotices(f.venue.vendorId)).toHaveLength(2);
  });
});
