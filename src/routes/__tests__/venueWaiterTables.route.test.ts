import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVenue, seedVenueStall, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { seedStall } from '@/__tests__/helpers/tables';
import { Table } from '@models/table.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const open = (auth: string, label: string) => request(app).post('/api/waiter/tables').set('Authorization', auth).send({ label });

describe('venue waiter — tables', () => {
  it('opens a venue table, ready for rounds and payments', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue, { fullName: 'Sipho' });
    const res = await open(w.auth, ' 7 ');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ label: '7', status: 'open', subtotal: 0, paidTotal: 0, orders: [], items: [], openedByName: 'Sipho' });
    const stored = await Table.findById(res.body.data._id).lean();
    expect(String(stored?.venueId)).toBe(venue.venueId);
    expect(stored?.eventId).toBeUndefined();
    expect(stored?.openedBy).toBe(w.waiterId);
  });

  it('refuses a second open table with the same number here — but not at another venue', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    expect((await open(w.auth, '7')).status).toBe(201);
    const again = await open(w.auth, '7');
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('Table 7 is already open');
    const elsewhere = await seedVenueWaiter(await seedVenue());
    expect((await open(elsewhere.auth, '7')).status).toBe(201);
  });

  it('needs a label', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const res = await open(w.auth, '   ');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('label is required');
  });

  it('shows a waiter their own tables; a shift lead sees the floor', async () => {
    const venue = await seedVenue();
    const sipho = await seedVenueWaiter(venue, { fullName: 'Sipho' });
    const lindiwe = await seedVenueWaiter(venue, { fullName: 'Lindiwe' });
    const lead = await seedVenueWaiter(venue, { fullName: 'Lead', grants: [OperatorGrant.SETTLE_TABLES, OperatorGrant.MANAGE_ALL_TABLES] });
    await open(sipho.auth, '1');
    await open(lindiwe.auth, '2');
    await open((await seedVenueWaiter(await seedVenue())).auth, '9');
    const mine = await request(app).get('/api/waiter/tables?status=open').set('Authorization', sipho.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.tables.map((t: { label: string }) => t.label)).toEqual(['1']);
    const floor = await request(app).get('/api/waiter/tables').set('Authorization', lead.auth);
    expect(floor.body.data.tables.map((t: { label: string }) => t.label).sort()).toEqual(['1', '2']);
    const searched = await request(app).get('/api/waiter/tables?q=2').set('Authorization', lead.auth);
    expect(searched.body.data.tables.map((t: { label: string }) => t.label)).toEqual(['2']);
  });

  it('refuses an unknown status filter', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const res = await request(app).get('/api/waiter/tables?status=paid').set('Authorization', w.auth);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unknown table status');
  });
});

describe('venue waiter — menu', () => {
  it("lists the venue's stocked products with their stall — never another venue's or an event's", async () => {
    const venue = await seedVenue();
    await seedVenueStall(venue.venueId, { name: 'Main Bar', product: 'Castle Lite', price: 2500, onHand: 10 });
    await seedVenueStall((await seedVenue()).venueId, { name: 'Other Bar', product: 'Other Beer', price: 100, onHand: 5 });
    await seedStall({ price: 100, onHand: 5, name: 'Event Beer' });
    const w = await seedVenueWaiter(venue);
    const res = await request(app).get('/api/waiter/products').set('Authorization', w.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.products[0]).toMatchObject({ name: 'Castle Lite', price: 2500, onHand: 10, merchantName: 'Main Bar', status: 'in_stock' });
  });
});

describe('venue waiter — cancelling a table', () => {
  it('cancels a table opened by mistake with nothing on it', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const tableId = (await open(w.auth, '7')).body.data._id;
    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`).set('Authorization', w.auth).send({ reason: 'wrong table number' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'voided', voidReason: 'wrong table number' });
    expect((await open(w.auth, '7')).status).toBe(201);
  });

  it('needs a reason', async () => {
    const w = await seedVenueWaiter(await seedVenue());
    const tableId = (await open(w.auth, '7')).body.data._id;
    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`).set('Authorization', w.auth).send({});
    expect(res.status).toBe(400);
  });

  it.each([
    ['something on it', { $push: { items: { merchantId: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(), name: 'Castle', unitPrice: 2500, qty: 1, addedBy: 'w' } }, $set: { subtotal: 2500 } }],
    ['something already paid', { $set: { paidTotal: 100 } }],
  ])('refuses a table with %s — that is a manager walkout', async (_what, update) => {
    const w = await seedVenueWaiter(await seedVenue());
    const tableId = (await open(w.auth, '7')).body.data._id;
    await Table.updateOne({ _id: tableId }, update);
    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`).set('Authorization', w.auth).send({ reason: 'left' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Walkouts are closed by a manager');
    expect((await Table.findById(tableId))!.status).toBe('open');
  });

  it("answers 404 for another waiter's table, another venue's table and a junk id", async () => {
    const venue = await seedVenue();
    const sipho = await seedVenueWaiter(venue);
    const lindiwe = await seedVenueWaiter(venue);
    const elsewhere = await seedVenueWaiter(await seedVenue(), { grants: [OperatorGrant.MANAGE_ALL_TABLES] });
    const tableId = (await open(sipho.auth, '7')).body.data._id;
    for (const [auth, id] of [[lindiwe.auth, tableId], [elsewhere.auth, tableId], [sipho.auth, 'junk']] as const) {
      const res = await request(app).post(`/api/waiter/tables/${id}/void`).set('Authorization', auth).send({ reason: 'x' });
      expect(res.status).toBe(404);
    }
    expect((await Table.findById(tableId))!.status).toBe('open');
  });
});
