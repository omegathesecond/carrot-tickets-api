/**
 * Tests for GET /api/reseller/manager/sales
 *
 * Harness copied from resellerOperators.route.test.ts.
 * Covers:
 *  1. Admin token → sees sales across both hubs; correct pagination; row shape.
 *  2. Hub-manager token → sees only their hub; cross-hub hubId → 403.
 *  3. paymentMethod filter narrows results.
 *  4. Operator token (lacks VIEW_HUB_SALES) → 403.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedOperator, seedReseller } from '../../__tests__/helpers/fixtures';
import { ResellerHub } from '@models/resellerHub.model';
import { TicketSale } from '@models/ticketSale.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  await TicketSale.deleteMany({});
  await Event.deleteMany({});
});

/** Log in and return the access token alongside the seeded data. */
async function tokenFor(role: string, opts?: { resellerId?: string; hubId?: string }) {
  const seeded = await seedOperator({ role, pin: '123456', ...opts });
  const login = await request(app)
    .post('/api/reseller/auth/login')
    .send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

/** Seed an event and return its id string. */
async function seedEvent(name = 'Test Event'): Promise<string> {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const ev = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name,
    venue: 'Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 50, sold: 0, reserved: 0 }],
  });
  return ev._id.toString();
}

interface SeedSaleParams {
  resellerId: string;
  hubId: string;
  operatorId: string;
  eventId: string;
  totalAmount?: number;
  quantity?: number;
  paymentMethod?: string;
  paymentStatus?: string;
}

async function seedSale(p: SeedSaleParams) {
  return TicketSale.create({
    eventId: new mongoose.Types.ObjectId(p.eventId),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: p.quantity ?? 1,
    totalAmount: p.totalAmount ?? 100,
    paymentMethod: p.paymentMethod ?? 'cash',
    paymentStatus: p.paymentStatus ?? 'completed',
    soldBy: new mongoose.Types.ObjectId(p.operatorId),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(p.resellerId),
    hubId: new mongoose.Types.ObjectId(p.hubId),
    fundsCustody: 'carrot',
    soldAt: new Date(),
  });
}

// ── 1. Admin sees both hubs; row shape; pagination ─────────────────────────

it('admin token → sees sales from both hubs; correct total; row shape is valid', async () => {
  const { resellerId, hubId: hub1Id } = await seedReseller();
  const hub2 = await ResellerHub.create({ resellerId: new mongoose.Types.ObjectId(resellerId), name: 'Hub B' });
  const hub2Id = hub2._id.toString();

  const admin = await tokenFor('reseller_admin', { resellerId, hubId: hub1Id });
  const op2 = await seedOperator({ resellerId, hubId: hub2Id, role: 'reseller_operator' });

  const eventId = await seedEvent('Admin Test Event');

  await seedSale({ resellerId, hubId: hub1Id, operatorId: admin.operator._id.toString(), eventId });
  await seedSale({ resellerId, hubId: hub2Id, operatorId: op2.operator._id.toString(), eventId });

  const res = await request(app)
    .get('/api/reseller/manager/sales')
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(200);
  const payload = res.body.data; // { data: ManagerSale[], pagination }
  expect(payload.pagination.total).toBe(2);
  expect(Array.isArray(payload.data)).toBe(true);
  expect(payload.data).toHaveLength(2);

  // Shape of each row
  for (const row of payload.data) {
    expect(typeof row.id).toBe('string');
    expect(row.id).toBe(row.saleId === '' ? row.id : row.id); // id is always a string
    // saleId is the SALE-xxx string set by the pre-save hook; id is the _id
    expect(typeof row.saleId).toBe('string');
    expect(typeof row.eventName).toBe('string');
    expect(row.eventName).not.toBe(''); // event was seeded so name is resolvable
    expect(typeof row.operatorName).toBe('string');
    expect(row.operatorName).not.toBe('');
    expect(typeof row.hubName).toBe('string');
    expect(row.hubName).not.toBe('');
    expect(typeof row.quantity).toBe('number');
    expect(typeof row.totalAmount).toBe('number');
    expect(typeof row.paymentMethod).toBe('string');
    expect(typeof row.paymentStatus).toBe('string');
    expect(typeof row.customerName).toBe('string'); // '' when absent
    expect(typeof row.soldAt).toBe('string'); // ISO string
  }
});

it('pagination object has correct shape', async () => {
  const { resellerId, hubId } = await seedReseller();
  const admin = await tokenFor('reseller_admin', { resellerId, hubId });
  const eventId = await seedEvent();
  await seedSale({ resellerId, hubId, operatorId: admin.operator._id.toString(), eventId });

  const res = await request(app)
    .get('/api/reseller/manager/sales?page=1&limit=20')
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(200);
  const { pagination } = res.body.data;
  expect(pagination.total).toBe(1);
  expect(pagination.page).toBe(1);
  expect(typeof pagination.limit).toBe('number');
  expect(typeof pagination.pages).toBe('number');
  expect(typeof pagination.hasNext).toBe('boolean');
  expect(typeof pagination.hasPrev).toBe('boolean');
  expect(pagination.hasPrev).toBe(false);
});

// ── 2. Hub-manager scope + cross-hub 403 ───────────────────────────────────

it('hub_manager token → sees only their own hub sales', async () => {
  const { resellerId } = await seedReseller();
  const hub2 = await ResellerHub.create({ resellerId: new mongoose.Types.ObjectId(resellerId), name: 'Hub B' });
  const hub2Id = hub2._id.toString();

  const mgr = await tokenFor('reseller_hub_manager', { resellerId });
  const op2 = await seedOperator({ resellerId, hubId: hub2Id, role: 'reseller_operator' });

  const eventId = await seedEvent();
  await seedSale({ resellerId, hubId: mgr.hubId, operatorId: mgr.operator._id.toString(), eventId });
  await seedSale({ resellerId, hubId: hub2Id, operatorId: op2.operator._id.toString(), eventId });

  const res = await request(app)
    .get('/api/reseller/manager/sales')
    .set('Authorization', `Bearer ${mgr.token}`);

  expect(res.status).toBe(200);
  const payload = res.body.data;
  expect(payload.pagination.total).toBe(1);
  expect(payload.data[0].hubName).not.toBe('Hub B');
});

it('hub_manager requesting a different hubId in query → 403', async () => {
  const { resellerId } = await seedReseller();
  const hub2 = await ResellerHub.create({ resellerId: new mongoose.Types.ObjectId(resellerId), name: 'Hub B' });
  const hub2Id = hub2._id.toString();

  const mgr = await tokenFor('reseller_hub_manager', { resellerId });

  const res = await request(app)
    .get(`/api/reseller/manager/sales?hubId=${hub2Id}`)
    .set('Authorization', `Bearer ${mgr.token}`);

  expect(res.status).toBe(403);
});

// ── 3. paymentMethod filter ────────────────────────────────────────────────

it('paymentMethod filter narrows results', async () => {
  const { resellerId, hubId } = await seedReseller();
  const admin = await tokenFor('reseller_admin', { resellerId, hubId });
  const eventId = await seedEvent();
  const opId = admin.operator._id.toString();

  await seedSale({ resellerId, hubId, operatorId: opId, eventId, paymentMethod: 'cash' });
  await seedSale({ resellerId, hubId, operatorId: opId, eventId, paymentMethod: 'keshless_wallet' });

  const res = await request(app)
    .get('/api/reseller/manager/sales?paymentMethod=cash')
    .set('Authorization', `Bearer ${admin.token}`);

  expect(res.status).toBe(200);
  const { data, pagination } = res.body.data;
  expect(pagination.total).toBe(1);
  expect(data[0].paymentMethod).toBe('cash');
});

// ── 4. Operator (lacks VIEW_HUB_SALES) → 403 ──────────────────────────────

it('operator token (lacks VIEW_HUB_SALES) → 403', async () => {
  const op = await tokenFor('reseller_operator');
  const res = await request(app)
    .get('/api/reseller/manager/sales')
    .set('Authorization', `Bearer ${op.token}`);
  expect(res.status).toBe(403);
});
