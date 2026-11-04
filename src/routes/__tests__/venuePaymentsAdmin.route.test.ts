import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, venueDashboardAuth, SeededVenue } from '@/__tests__/helpers/venueFloor';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Table } from '@models/table.model';
import { Venue } from '@models/venue.model';
import { VenuePayment } from '@models/venuePayment.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const URL = '/api/tickets/venue/payments';
const DAY = '?from=2026-10-01T00:00:00%2B02:00&to=2026-10-02T00:00:00%2B02:00';
const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00+02:00`);
const oid = () => new mongoose.Types.ObjectId();

/**
 * 1 Oct: Sipho (waiter) took E75 at table 7 — E30 cash + E45 card with a E5 card tip (slip 0192);
 * Sipho took E25 cash at table 7 for one beer (by items); Nomsa (till) sold E50 cash over the Main Bar counter.
 * 30 Sep: one E10 cash payment that must stay out of the day.
 */
async function ledger(venue: SeededVenue) {
  const bar = await Merchant.create({ name: 'Main Bar', venueId: venue.venueId });
  const kitchen = await Merchant.create({ name: 'Kitchen', venueId: venue.venueId });
  const lineId = oid();
  const table = await Table.create({
    venueId: venue.venueId, label: '7', status: 'open', openedBy: String(oid()), subtotal: 14000, paidTotal: 10000, orders: [],
    items: [{ _id: lineId, merchantId: bar._id, productId: oid(), name: 'Castle Lite', unitPrice: 2500, qty: 2, addedBy: 'w', paidQty: 1 }],
  });
  const sipho = String(oid());
  const nomsa = String(oid());
  const base = { venueId: venue.venueId, takenByType: 'Waiter', staffName: 'Sipho', takenBy: sipho, source: 'table', tableId: table._id, tableLabel: '7', merchantIds: [bar._id, kitchen._id] };
  const mixed = await VenuePayment.create({ ...base, clientTxnId: 'p1', tenders: [{ method: 'cash', amount: 3000, tip: 0 }, { method: 'card', amount: 4500, tip: 500, reference: '0192' }], applied: 7500, tips: 500, at: at('21:14') });
  const byItems = await VenuePayment.create({ ...base, clientTxnId: 'p2', tenders: [{ method: 'cash', amount: 2500, tip: 0 }], applied: 2500, tips: 0, lines: [{ lineId, qty: 1 }], at: at('21:30') });
  const charge = await MerchantCharge.create({ merchantId: bar._id, venueId: venue.venueId, amount: 5000, fee: 0, netAmount: 5000, clientTxnId: 's1', staffName: 'Nomsa', items: [{ productId: oid(), name: 'Castle Lite', unitPrice: 2500, qty: 2, lineTotal: 5000 }] });
  const counter = await VenuePayment.create({ venueId: venue.venueId, source: 'counter', merchantChargeId: charge._id, merchantName: 'Main Bar', merchantIds: [bar._id], clientTxnId: 's1', tenders: [{ method: 'cash', amount: 5000, tip: 0 }], applied: 5000, tips: 0, takenBy: nomsa, takenByType: 'MerchantOperator', staffName: 'Nomsa', at: at('22:05') });
  await VenuePayment.create({ ...base, clientTxnId: 'p0', tenders: [{ method: 'cash', amount: 1000, tip: 0 }], applied: 1000, tips: 0, at: new Date('2026-09-30T20:00:00+02:00') });
  return { bar: String(bar._id), kitchen: String(kitchen._id), tableId: String(table._id), chargeId: String(charge._id), sipho, nomsa, mixed: String(mixed._id), byItems: String(byItems._id), counter: String(counter._id) };
}

describe('dashboard — venue payments', () => {
  it('lists the day newest first, with totals for the whole range and what is unpaid on open tables now', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const res = await request(app).get(`${URL}${DAY}`).set('Authorization', await venueDashboardAuth(venue));
    expect(res.status).toBe(200);
    expect(res.body.data.payments.map((p: { id: string }) => p.id)).toEqual([l.counter, l.byItems, l.mixed]);
    expect(res.body.data.payments[0]).toMatchObject({ source: 'counter', where: 'Counter · Main Bar', staffName: 'Nomsa', takenByType: 'MerchantOperator', cash: 5000, card: 0, tip: 0, total: 5000, references: [], byItems: false });
    expect(res.body.data.payments[1]).toMatchObject({ where: 'Table 7', byItems: true, cash: 2500 });
    expect(res.body.data.payments[2]).toMatchObject({ where: 'Table 7', staffName: 'Sipho', cash: 3000, card: 4500, tip: 500, total: 8000, references: ['0192'] });
    expect(res.body.data.totals).toEqual({ sales: 15000, cash: 10500, card: 4500, tips: 500, cashTips: 0, cardTips: 500 });
    expect(res.body.data.unpaidOnOpenTables).toBe(4000);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 25, total: 3, totalPages: 1 });
    expect(res.body.data.filterOptions.staff.map((s: { name: string }) => s.name)).toEqual(['Nomsa', 'Sipho']);
    expect(res.body.data.filterOptions.stalls.map((s: { name: string }) => s.name)).toEqual(['Kitchen', 'Main Bar']);
  });

  it('totals cover the whole range, not the page', async () => {
    const venue = await seedVenue();
    await ledger(venue);
    const res = await request(app).get(`${URL}${DAY}&limit=1&page=2`).set('Authorization', await venueDashboardAuth(venue));
    expect(res.body.data.payments).toHaveLength(1);
    expect(res.body.data.pagination).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
    expect(res.body.data.totals.sales).toBe(15000);
  });

  it('filters by method, staff, stall, source and slip reference', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const ids = async (query: string) => (await request(app).get(`${URL}${DAY}&${query}`).set('Authorization', await venueDashboardAuth(venue))).body.data.payments.map((p: { id: string }) => p.id);
    expect(await ids('method=card')).toEqual([l.mixed]);
    expect(await ids(`staffId=${l.nomsa}`)).toEqual([l.counter]);
    expect(await ids(`merchantId=${l.kitchen}`)).toEqual([l.byItems, l.mixed]);
    expect(await ids('source=counter')).toEqual([l.counter]);
    expect(await ids('reference=0192')).toEqual([l.mixed]);
    const card = await request(app).get(`${URL}${DAY}&method=card`).set('Authorization', await venueDashboardAuth(venue));
    expect(card.body.data.totals).toMatchObject({ sales: 7500, cash: 3000, card: 4500 });
  });

  it('an upper-case staff or stall id filters the same rows as the lower-case one', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const ids = async (query: string) => (await request(app).get(`${URL}${DAY}&${query}`).set('Authorization', await venueDashboardAuth(venue))).body.data.payments.map((p: { id: string }) => p.id);
    const staffOf = (hex: string) => hex.toUpperCase();
    expect(await ids(`staffId=${staffOf(l.nomsa)}`)).toEqual(await ids(`staffId=${l.nomsa}`));
    expect(await ids(`staffId=${staffOf(l.nomsa)}`)).toEqual([l.counter]);
    expect(await ids(`staffId=${staffOf(l.sipho)}`)).toEqual([l.byItems, l.mixed]);
    expect(await ids(`merchantId=${l.kitchen.toUpperCase()}`)).toEqual([l.byItems, l.mixed]);
  });

  it('refuses unknown filter values and a backwards or malformed range', async () => {
    const venue = await seedVenue();
    const auth = await venueDashboardAuth(venue);
    for (const [query, message] of [
      ['method=momo', 'Unknown payment method'], ['source=online', 'Unknown payment source'],
      ['staffId=junk', 'Invalid staffId'], ['merchantId=junk', 'Invalid merchantId'],
      ['page=abc', 'Invalid page'], ['limit=0', 'Invalid limit'], ['method[toString]=x', 'Invalid query parameter: method'],
      ['from=2026-10-02T00:00:00%2B02:00&to=2026-10-01T00:00:00%2B02:00', 'from must be before to'],
      ['from=yesterday', 'from and to must be ISO dates'],
    ] as const) {
      const res = await request(app).get(`${URL}?${query}`).set('Authorization', auth);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    }
    expect((await request(app).get(URL).set('Authorization', auth)).status).toBe(200);
  });

  it('an array or object-shaped value for any filter is a 400 for that filter, never a crash', async () => {
    const venue = await seedVenue();
    const auth = await venueDashboardAuth(venue);
    for (const [query, message] of [
      ['from[a]=b', 'Invalid query parameter: from'], ['from[toString]=x', 'Invalid query parameter: from'],
      ['to[a]=b', 'Invalid query parameter: to'], ['from[]=2026-10-01T00:00:00%2B02:00', 'Invalid query parameter: from'],
      ['method[toString]=x', 'Invalid query parameter: method'], ['method[]=cash', 'Invalid query parameter: method'],
      ['source[toString]=x', 'Invalid query parameter: source'], ['source=table&source=counter', 'Invalid query parameter: source'],
      ['staffId[toString]=x', 'Invalid query parameter: staffId'], ['staffId[]=aaaaaaaaaaaaaaaaaaaaaaaa', 'Invalid query parameter: staffId'],
      ['merchantId[toString]=x', 'Invalid query parameter: merchantId'], ['reference[toString]=x', 'Invalid query parameter: reference'],
      ['page[]=1', 'Invalid query parameter: page'], ['page[toString]=x', 'Invalid query parameter: page'], ['limit[toString]=x', 'Invalid query parameter: limit'],
    ] as const) {
      const res = await request(app).get(`${URL}?${query}`).set('Authorization', auth);
      expect([query, res.status, res.body.message]).toEqual([query, 400, message]);
    }
  });

  it('opens one payment: its tenders, what it covered, and the table\'s other payments', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const auth = await venueDashboardAuth(venue);
    const byItems = (await request(app).get(`${URL}/${l.byItems}`).set('Authorization', auth)).body.data;
    expect(byItems).toMatchObject({ id: l.byItems, where: 'Table 7', applied: 2500, tips: 0, total: 2500, covers: { kind: 'items', items: [{ name: 'Castle Lite', qty: 1, unitPrice: 2500, lineTotal: 2500 }] } });
    expect(byItems.table).toMatchObject({ id: l.tableId, label: '7', status: 'open', subtotal: 14000, paidTotal: 10000 });
    expect(byItems.table.otherPayments.map((p: { id: string }) => p.id)).toContain(l.mixed);
    const mixed = (await request(app).get(`${URL}/${l.mixed}`).set('Authorization', auth)).body.data;
    expect(mixed.covers).toEqual({ kind: 'amount' });
    expect(mixed.tenders).toEqual([{ method: 'cash', amount: 3000, tip: 0 }, { method: 'card', amount: 4500, tip: 500, reference: '0192' }]);
    const counter = (await request(app).get(`${URL}/${l.counter}`).set('Authorization', auth)).body.data;
    expect(counter).toMatchObject({ where: 'Counter · Main Bar', covers: { kind: 'sale', items: [{ name: 'Castle Lite', qty: 2, lineTotal: 5000 }] } });
    expect(counter.table).toBeUndefined();
  });

  it('an upper-case payment id opens the same payment', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    const res = await request(app).get(`${URL}/${l.mixed.toUpperCase()}`).set('Authorization', await venueDashboardAuth(venue));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(l.mixed);
  });

  it("needs tickets:view_revenue; another venue's payment and a junk id are 404", async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    expect((await request(app).get(URL).set('Authorization', await venueDashboardAuth(venue, [TicketsPermission.MANAGE_VENUE, TicketsPermission.MANAGE_STOCK]))).status).toBe(403);
    expect((await request(app).get(`${URL}/${l.mixed}`).set('Authorization', await venueDashboardAuth(venue, [TicketsPermission.MANAGE_VENUE]))).status).toBe(403);
    const other = await venueDashboardAuth(await seedVenue());
    const foreign = await request(app).get(`${URL}/${l.mixed}`).set('Authorization', other);
    expect(foreign.status).toBe(404);
    expect(foreign.body.message).toBe('Payment not found');
    const junk = await request(app).get(`${URL}/junk`).set('Authorization', await venueDashboardAuth(venue));
    expect(junk.status).toBe(404);
    expect(junk.body.message).toBe('Payment not found');
    expect((await request(app).get(`${URL}${DAY}`).set('Authorization', other)).body.data.payments).toEqual([]);
  });

  it("another venue's staff and stalls never reach the filter options or the totals", async () => {
    const venue = await seedVenue();
    await ledger(venue);
    const stranger = await seedVenue();
    await ledger(stranger);
    const res = await request(app).get(`${URL}${DAY}`).set('Authorization', await venueDashboardAuth(venue));
    expect(res.body.data.pagination.total).toBe(3);
    expect(res.body.data.totals.sales).toBe(15000);
    expect(res.body.data.filterOptions.staff).toHaveLength(2);
    expect(res.body.data.filterOptions.stalls).toHaveLength(2);
    expect(res.body.data.unpaidOnOpenTables).toBe(4000);
  });

  it('a suspended venue is refused on both routes', async () => {
    const venue = await seedVenue();
    const l = await ledger(venue);
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    for (const res of [
      await request(app).get(URL).set('Authorization', await venueDashboardAuth(venue)),
      await request(app).get(`${URL}/${l.mixed}`).set('Authorization', await venueDashboardAuth(venue)),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Venue trading is suspended');
    }
  });

  describe('a payment whose record is broken fails loudly — never an empty stand-in', () => {
    const detailOf = async (venue: SeededVenue, id: string) => {
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        return await request(app).get(`${URL}/${id}`).set('Authorization', await venueDashboardAuth(venue));
      } finally {
        quiet.mockRestore();
      }
    };

    it("a counter payment whose sale is gone is a 500, not 200 with no items", async () => {
      const venue = await seedVenue();
      const l = await ledger(venue);
      await MerchantCharge.deleteOne({ _id: l.chargeId });
      const res = await detailOf(venue, l.counter);
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("that payment's sale is not on record");
    });

    it('a table payment whose table is gone is a 500, not a detail without its table', async () => {
      const venue = await seedVenue();
      const l = await ledger(venue);
      await Table.deleteOne({ _id: l.tableId });
      const res = await detailOf(venue, l.mixed);
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("that payment's table is not on record");
    });
  });
});
