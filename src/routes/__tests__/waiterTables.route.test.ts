import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS } from '@interfaces/waiter.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

// addItem writes its table-push + stock-CAS in one transaction
// (StockService.applyMovement always opens one), so this suite needs a
// replica set, not the standalone mongod the open/list tests alone would need.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** One waiter, working one freshly-created cashless event, token in hand. */
async function seedFloor(permissions: string[] = WAITER_PERMISSIONS) {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(new mongoose.Types.ObjectId()),
    role: 'waiter', permissions, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token };
}

/** A stocked stall on a given event, for the addItem route tests. */
async function seedStallOn(eventId: string, opts: { price: number; onHand: number }) {
  const merchant = await Merchant.create({ name: 'Test Stall', eventId });
  const product = await Product.create({
    eventId, name: 'Beer', category: ProductCategory.BEER, price: opts.price,
  });
  await StockService.applyMovement({
    eventId, merchantId: merchant._id, productId: product._id, delta: opts.onHand,
    reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: String(merchant._id),
  });
  return { merchantId: String(merchant._id), productId: String(product._id) };
}

describe('waiter tables — open and list', () => {
  it('opens a table by number', async () => {
    const { token } = await seedFloor();
    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(res.status).toBe(201);
    expect(res.body.data.label).toBe('7');
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.subtotal).toBe(0);
  });

  it('refuses a second open table under the same number', async () => {
    const { token } = await seedFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    const again = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already open/i);
  });

  it('requires a label', async () => {
    const { token } = await seedFloor();
    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('lists only this event tables', async () => {
    const mine = await seedFloor();
    const other = await seedFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${mine.token}`).send({ label: '7' });

    const res = await request(app).get('/api/waiter/tables')
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.body.data.tables).toEqual([]);
  });
});

describe('waiter tables — add an item', () => {
  it('adds an item from a stall onto a table', async () => {
    const { eventId, token } = await seedFloor();
    const { merchantId, productId } = await seedStallOn(eventId, { price: 3000, onHand: 10 });
    const opened = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });
    const tableId = opened.body.data._id;

    const res = await request(app).post(`/api/waiter/tables/${tableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, qty: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].unitPrice).toBe(3000);
    expect(res.body.data.subtotal).toBe(6000);
  });

  // Proves the route is actually GATED, not just that the service works when
  // called directly. A 401 here would mean the request never reached
  // requireWaiterPermission at all — see the gate-removal check in the
  // report for how this was verified to actually depend on the middleware.
  it('403s a waiter token missing MANAGE_TABLES — authenticated, but not authorised', async () => {
    const { token } = await seedFloor([]);
    const someTableId = new mongoose.Types.ObjectId().toString();

    const res = await request(app).post(`/api/waiter/tables/${someTableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({
        merchantId: new mongoose.Types.ObjectId().toString(),
        productId: new mongoose.Types.ObjectId().toString(),
        qty: 1,
      });

    expect(res.status).toBe(403);
  });

  // Proves loadWaiterEvent's eventId — taken from the verified JWT, never the
  // request body — is what scopes the table lookup. The stall/product here
  // are seeded on the WAITER'S OWN event and so pass their own checks fine;
  // only the table itself belongs elsewhere, isolating this to the table scope.
  it('refuses a table that belongs to another event', async () => {
    const other = await seedFloor();
    const otherTable = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${other.token}`).send({ label: '7' });
    const otherTableId = otherTable.body.data._id;

    const mine = await seedFloor();
    const { merchantId, productId } = await seedStallOn(mine.eventId, { price: 3000, onHand: 10 });

    const res = await request(app).post(`/api/waiter/tables/${otherTableId}/items`)
      .set('Authorization', `Bearer ${mine.token}`).send({ merchantId, productId, qty: 1 });

    expect(res.status).not.toBe(200);
    expect(res.body.message).toMatch(/not found/i);
  });
});
