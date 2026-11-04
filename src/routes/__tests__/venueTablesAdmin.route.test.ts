import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueStall, seedVenueTill, seedVenueWaiter, venueDashboardAuth } from '@/__tests__/helpers/venueFloor';
import { seedStallAndTable } from '@/__tests__/helpers/tables';
import { seedVendorSessionToken } from '@/__tests__/helpers/auth';
import { Table } from '@models/table.model';
import { Venue } from '@models/venue.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { StockService } from '@services/stock.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const URL = '/api/tickets/venue/tables';

/** Table 7 (Sipho): 2 beers + 1 burger = 14000, the bar's round handed out, E40 paid. */
async function floor() {
  const venue = await seedVenue();
  const bar = await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
  const kitchen = await seedVenueStall(venue.venueId, { name: 'Kitchen', product: 'Burger', price: 9000, onHand: 3 });
  const waiter = await seedVenueWaiter(venue, { fullName: 'Sipho' });
  const till = await seedVenueTill(venue, bar.merchantId);
  const tableId = (await request(app).post('/api/waiter/tables').set('Authorization', waiter.auth).send({ label: '7' })).body.data._id as string;
  const round = await request(app).post(`/api/waiter/tables/${tableId}/orders`).set('Authorization', waiter.auth).send({ clientTxnId: 'r1', items: [{ ...bar, qty: 2 }, { ...kitchen, qty: 1 }] });
  const orderOf = (merchantId: string) => round.body.data.orders.find((o: { merchantId: string }) => o.merchantId === merchantId)._id as string;
  const barOrder = orderOf(bar.merchantId);
  await request(app).post(`/api/merchant/tables/${tableId}/orders/${barOrder}/hand-out`).set('Authorization', till.auth).send({});
  await request(app).post(`/api/waiter/tables/${tableId}/payments`).set('Authorization', waiter.auth).send({ clientTxnId: 'p1', tenders: [{ method: 'cash', amount: 4000, tip: 200 }] });
  return { venue, bar, kitchen, waiter, tableId, barOrder, kitchenOrder: orderOf(kitchen.merchantId), auth: await venueDashboardAuth(venue) };
}
type Floor = Awaited<ReturnType<typeof floor>>;

const walkout = (f: Floor) => request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'Guests left without paying' });
const queue = (auth: string) => request(app).get('/api/merchant/orders').set('Authorization', auth);
const handOut = (auth: string, f: Floor, orderId: string) => request(app).post(`/api/merchant/tables/${f.tableId}/orders/${orderId}/hand-out`).set('Authorization', auth).send({});
const accept = (f: Floor, orderId: string) => request(app).post(`/api/waiter/tables/${f.tableId}/orders/${orderId}/accept`).set('Authorization', f.waiter.auth).send({});
const storedStatus = async (f: Floor, orderId: string) => (await Table.findById(f.tableId))!.orders!.find((o) => String(o._id) === orderId)!.status;

describe('dashboard — venue tables', () => {
  it('lists the open floor: who has it, the bill, what is paid, where its rounds are', async () => {
    const f = await floor();
    const res = await request(app).get(URL).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({ count: 1, balance: 10000 });
    expect(res.body.data.tables).toEqual([expect.objectContaining({
      id: f.tableId, label: '7', status: 'open', waiterId: f.waiter.waiterId, waiterName: 'Sipho',
      subtotal: 14000, paidTotal: 4000, balance: 10000, orders: { sent: 1, handedOut: 1, collected: 0 },
    })]);
    expect(res.body.data.truncated).toBe(false);
    expect((await request(app).get(`${URL}?status=settled`).set('Authorization', f.auth)).body.data.tables).toEqual([]);
    const bad = await request(app).get(`${URL}?status=paid`).set('Authorization', f.auth);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Unknown table status');
  });

  it('opens one table: its rounds with stall names, its lines, its payments', async () => {
    const f = await floor();
    const res = await request(app).get(`${URL}/${f.tableId}`).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    const t = res.body.data;
    expect(t).toMatchObject({ id: f.tableId, label: '7', waiterName: 'Sipho', balance: 10000 });
    expect(t.items.map((l: { name: string; merchantName: string; paidQty: number }) => [l.name, l.merchantName, l.paidQty]).sort()).toEqual([['Burger', 'Kitchen', 0], ['Castle Lite', 'Main Bar', 0]]);
    expect(t.rounds.map((r: { merchantName: string; status: string }) => [r.merchantName, r.status]).sort()).toEqual([['Kitchen', 'sent'], ['Main Bar', 'handed_out']]);
    expect(t.payments).toEqual([expect.objectContaining({ staffName: 'Sipho', applied: 4000, tips: 200, tenders: [{ method: 'cash', amount: 4000, tip: 200 }] })]);
  });

  it('a manager closes a walkout: no stock back, no stall takings, the balance written off', async () => {
    const f = await floor();
    const res = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'Guests left without paying' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'voided', voidReason: 'Guests left without paying', subtotal: 14000, paidTotal: 4000, balance: 10000 });
    expect(await StockService.getOnHand(f.bar.merchantId, f.bar.productId)).toBe(8);
    expect(await MerchantCharge.countDocuments()).toBe(0);
    const walked = await request(app).get(`${URL}?status=voided`).set('Authorization', f.auth);
    expect(walked.body.data.tables).toHaveLength(1);
    expect(walked.body.data.totals).toEqual({ count: 1, balance: 10000 });
    // the number is free for the next guests
    expect((await request(app).post('/api/waiter/tables').set('Authorization', f.waiter.auth).send({ label: '7' })).status).toBe(201);
    const again = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'again' });
    expect(again.status).toBe(409);
  });

  it('a walkout needs a reason and tickets:manage_venue; viewing needs revenue or venue access', async () => {
    const f = await floor();
    const noReason = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: '  ' });
    expect(noReason.status).toBe(400);
    const viewer = await venueDashboardAuth(f.venue, [TicketsPermission.VIEW_REVENUE]);
    expect((await request(app).get(URL).set('Authorization', viewer)).status).toBe(200);
    expect((await request(app).get(`${URL}/${f.tableId}`).set('Authorization', viewer)).status).toBe(200);
    expect((await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', viewer).send({ reason: 'x' })).status).toBe(403);
    const stockOnly = await venueDashboardAuth(f.venue, [TicketsPermission.MANAGE_STOCK]);
    expect((await request(app).get(URL).set('Authorization', stockOnly)).status).toBe(403);
    expect((await Table.findById(f.tableId))!.status).toBe('open');
  });

  it("answers 404 for another venue's table and a junk id", async () => {
    const f = await floor();
    const other = await venueDashboardAuth(await seedVenue());
    for (const [auth, id] of [[other, f.tableId], [f.auth, 'junk'], [f.auth, '000000000000000000000001']] as const) {
      expect((await request(app).get(`${URL}/${id}`).set('Authorization', auth)).status).toBe(404);
      expect((await request(app).post(`${URL}/${id}/void`).set('Authorization', auth).send({ reason: 'x' })).status).toBe(404);
    }
    expect((await request(app).get(URL).set('Authorization', other)).body.data.tables).toEqual([]);
    expect((await Table.findById(f.tableId))!.status).toBe('open');
  });

  it('an uppercase table id in the URL reads the same table', async () => {
    const f = await floor();
    const res = await request(app).get(`${URL}/${f.tableId.toUpperCase()}`).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(f.tableId);
  });
});

describe('dashboard — venue tables, edges', () => {
  it('totals cover every table of the status, not just the 200 rows listed', async () => {
    const venue = await seedVenue();
    const at = new Date();
    const rows = Array.from({ length: 201 }, (_, i) => ({
      venueId: venue.venueId, label: `W${i}`, status: 'voided', openedBy: 'fixture-waiter', items: [], orders: [],
      subtotal: 1000 + i * 10, paidTotal: (i % 4) * 100, voidedAt: at, voidReason: 'Walked', voidedBy: 'fixture',
    }));
    await Table.insertMany(rows);
    const writtenOff = rows.reduce((sum, r) => sum + r.subtotal - r.paidTotal, 0);
    const res = await request(app).get(`${URL}?status=voided`).set('Authorization', await venueDashboardAuth(venue));
    expect(res.status).toBe(200);
    expect(res.body.data.tables).toHaveLength(200);
    expect(res.body.data.totals).toEqual({ count: 201, balance: writtenOff });
    expect(res.body.data.truncated).toBe(true);
  });

  it('an empty status has zero totals and is not truncated', async () => {
    const res = await request(app).get(`${URL}?status=settled`).set('Authorization', await venueDashboardAuth(await seedVenue()));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ tables: [], totals: { count: 0, balance: 0 }, truncated: false });
  });

  it("never reaches an EVENT's table: 404 on the read and on the write, which is not made", async () => {
    const f = await floor();
    const { table } = await seedStallAndTable({ price: 100, onHand: 1 });
    const id = String(table._id);
    const read = await request(app).get(`${URL}/${id}`).set('Authorization', f.auth);
    expect(read.status).toBe(404);
    expect(read.body.message).toBe('Table not found');
    const write = await request(app).post(`${URL}/${id}/void`).set('Authorization', f.auth).send({ reason: 'Guests left without paying' });
    expect(write.status).toBe(404);
    expect(write.body.message).toBe('Table not found');
    expect((await Table.findById(id))!.status).toBe('open');
  });

  it('a token with ONLY tickets:manage_venue can list, open a table and close a walkout', async () => {
    const f = await floor();
    const manager = await venueDashboardAuth(f.venue, [TicketsPermission.MANAGE_VENUE]);
    expect((await request(app).get(URL).set('Authorization', manager)).status).toBe(200);
    expect((await request(app).get(`${URL}/${f.tableId}`).set('Authorization', manager)).status).toBe(200);
    const closed = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', manager).send({ reason: 'Guests left without paying' });
    expect(closed.status).toBe(200);
    // The restricted grant belongs to persisted staff, who is the audit actor.
    const staffId = JSON.parse(Buffer.from(manager.split('.')[1]!, 'base64url').toString()).userId;
    expect((await Table.findById(f.tableId))!.voidedBy).toBe(staffId);
  });

  it('an UPPER-CASE table id closes the walkout too', async () => {
    const f = await floor();
    const res = await request(app).post(`${URL}/${f.tableId.toUpperCase()}/void`).set('Authorization', f.auth).send({ reason: 'Guests left without paying' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: f.tableId, status: 'voided' });
    expect((await Table.findById(f.tableId))!.status).toBe('voided');
  });

  it('after a walkout the table still shows its payment; who closed it and why is kept (reason trimmed)', async () => {
    const f = await floor();
    const manager = `Bearer ${await seedVendorSessionToken(f.venue.vendorId, { permissions: [TicketsPermission.MANAGE_VENUE] })}`;
    const subUserId = JSON.parse(Buffer.from(manager.split('.')[1]!, 'base64url').toString()).userId;
    const res = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', manager).send({ reason: '  Guests left  ' });
    expect(res.status).toBe(200);
    expect(res.body.data.voidReason).toBe('Guests left');
    const stored = (await Table.findById(f.tableId))!;
    expect(stored.voidedBy).toBe(subUserId);
    expect(stored.voidReason).toBe('Guests left');
    const detail = await request(app).get(`${URL}/${f.tableId}`).set('Authorization', f.auth);
    expect(detail.body.data.payments).toEqual([expect.objectContaining({ staffName: 'Sipho', applied: 4000, tips: 200 })]);
    expect(detail.body.data).toMatchObject({ status: 'voided', paidTotal: 4000, balance: 10000 });
  });

  it('a reason over 200 characters is refused and nothing is written; 200 is fine', async () => {
    const f = await floor();
    const tooLong = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'x'.repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.message).toBe('reason must be 200 characters or fewer');
    expect((await Table.findById(f.tableId))!.status).toBe('open');
    const ok = await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'x'.repeat(200) });
    expect(ok.status).toBe(200);
  });

  it('a suspended venue is refused on all three routes', async () => {
    const f = await floor();
    await Venue.updateOne({ _id: f.venue.venueId }, { $set: { status: 'suspended' } });
    for (const res of [
      await request(app).get(URL).set('Authorization', f.auth),
      await request(app).get(`${URL}/${f.tableId}`).set('Authorization', f.auth),
      await request(app).post(`${URL}/${f.tableId}/void`).set('Authorization', f.auth).send({ reason: 'Guests left without paying' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Venue trading is suspended');
    }
    expect((await Table.findById(f.tableId))!.status).toBe('open');
  });
});

describe('a walkout leaves nothing at the bar', () => {
  it('the round still `sent` drops out of the till queue once the table is voided', async () => {
    const f = await floor();
    const kitchenTill = await seedVenueTill(f.venue, f.kitchen.merchantId, { fullName: 'Chef' });
    expect((await queue(kitchenTill.auth)).body.data.orders).toEqual([expect.objectContaining({ orderId: f.kitchenOrder, status: 'sent' })]);
    expect((await walkout(f)).status).toBe(200);
    expect((await queue(kitchenTill.auth)).body.data.orders).toEqual([]);
  });

  it('a round still `sent` cannot be handed out after the walkout: 409, nothing written', async () => {
    const f = await floor();
    const kitchenTill = await seedVenueTill(f.venue, f.kitchen.merchantId, { fullName: 'Chef' });
    await walkout(f);
    const res = await handOut(kitchenTill.auth, f, f.kitchenOrder);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('table is not open (status: voided)');
    expect(await storedStatus(f, f.kitchenOrder)).toBe('sent');
  });

  it('a round handed out before the walkout cannot be accepted after it: 409, nothing written', async () => {
    const f = await floor();
    await walkout(f);
    const res = await accept(f, f.barOrder);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('table is not open (status: voided)');
    expect(await storedStatus(f, f.barOrder)).toBe('handed_out');
  });

  it('a table PAID IN FULL still has its rounds in the queue, and they can still be handed out', async () => {
    const f = await floor();
    const kitchenTill = await seedVenueTill(f.venue, f.kitchen.merchantId, { fullName: 'Chef' });
    const paid = await request(app).post(`/api/waiter/tables/${f.tableId}/payments`).set('Authorization', f.waiter.auth).send({ clientTxnId: 'p2', tenders: [{ method: 'cash', amount: 10000 }] });
    expect(paid.status).toBe(200);
    expect((await Table.findById(f.tableId))!.status).toBe('settled');
    expect((await queue(kitchenTill.auth)).body.data.orders).toEqual([expect.objectContaining({ orderId: f.kitchenOrder, status: 'sent' })]);
    const out = await handOut(kitchenTill.auth, f, f.kitchenOrder);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ orderId: f.kitchenOrder, status: 'handed_out' });
    expect((await accept(f, f.kitchenOrder)).status).toBe(200);
  });
});
