import { CashCollection } from '@models/cashCollection.model';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Cashier } from '@models/cashier.model';
import { Waiter } from '@models/waiter.model';
import { GateOperator } from '@models/gateOperator.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Table } from '@models/table.model';
import { EventStatus } from '@interfaces/event.interface';

const vendorId = '64c000000000000000000a01';
const auth = (admin: boolean, permissions: string[] = []) => `Bearer ${jwt.sign({
  app: 'tickets', userType: 'vendor', role: 'tickets_owner', vendorId,
  isSuperAdmin: admin, permissions,
}, process.env['JWT_SECRET']!)}`;

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function setup() {
  const future = new Date(Date.now() + 864e5);
  const event = await Event.create({ vendorId, name: 'Show', venue: 'V', eventDate: future,
    startTime: future, endTime: future, status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  const stall = await Merchant.create({ eventId: event._id, name: 'Main Bar' });
  return { event, stall };
}

const populations = [
  { path: 'cashiers', model: Cashier }, { path: 'waiters', model: Waiter },
  { path: 'gate-operators', model: GateOperator }, { path: 'merchant-operators', model: MerchantOperator },
];

for (const { path, model } of populations) describe(path, () => {
  async function create() {
    const { event, stall } = await setup();
    const row = await (model as any).create({ fullName: 'Thabo', phoneNumber: '+26870000001', scope: 'organizer', vendorId,
      eventId: event._id, eventIds: [event._id], merchantId: stall._id, loginCode: 'ABC123', pin: '012345' });
    return { row, event, stall };
  }

  it('allows a Super Admin with no explicit permissions to edit and view the PIN', async () => {
    const { row } = await create();
    const res = await request(app).patch(`/api/tickets/${path}/${row._id}`).set('Authorization', auth(true))
      .send({ fullName: 'New name', phoneNumber: '' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/encryptedPin|012345|\$2[ab]\$/);
    expect((await (model as any).findById(row._id)).phoneNumber).toBeUndefined();
    const reveal = await request(app).post(`/api/tickets/${path}/${row._id}/reveal-pin`).set('Authorization', auth(true));
    expect(reveal.status).toBe(200);
    expect(reveal.body.data).toEqual({ loginCode: 'ABC123', pin: '012345' });
    expect(reveal.headers['cache-control']).toBe('no-store');
  });

  it('refuses reveal/delete to an organizer who has management permission', async () => {
    const { row } = await create();
    const header = auth(false, ['tickets:manage_access']);
    expect((await request(app).post(`/api/tickets/${path}/${row._id}/reveal-pin`).set('Authorization', header)).status).toBe(403);
    expect((await request(app).delete(`/api/tickets/${path}/${row._id}`).set('Authorization', header)).status).toBe(403);
    expect((await (model as any).findById(row._id)).isActive).toBe(true);
  });

  it('deletes from management but retains history and prevents reactivation or revealing credentials', async () => {
    const { row, event, stall } = await create();
    const res = await request(app).delete(`/api/tickets/${path}/${row._id}`).set('Authorization', auth(true));
    expect(res.status).toBe(200);
    const retained = await (model as any).findById(row._id);
    expect(retained.deletedAt).toBeTruthy();
    expect(retained.isActive).toBe(false);
    const listPath = path === 'merchant-operators' ? `merchants/${stall._id}/operators` : `${path}?eventId=${event._id}`;
    const listed = await request(app).get(`/api/tickets/${listPath}`).set('Authorization', auth(true));
    expect(listed.status).toBe(200);
    expect(path === 'merchant-operators' ? listed.body.data.operators : listed.body.data).toEqual([]);
    expect((await request(app).patch(`/api/tickets/${path}/${row._id}`).set('Authorization', auth(true)).send({ isActive: true })).status).toBe(404);
    expect((await request(app).post(`/api/tickets/${path}/${row._id}/reveal-pin`).set('Authorization', auth(true))).status).toBe(404);
  });

  it('reset stores a recoverable new PIN; an older hash-only PIN fails explicitly', async () => {
    const { row } = await create();
    await (model as any).updateOne({ _id: row._id }, { $unset: { encryptedPin: 1 } });
    const old = await request(app).post(`/api/tickets/${path}/${row._id}/reveal-pin`).set('Authorization', auth(true));
    expect(old.status).toBe(409);
    expect(old.body.message).toMatch(/Reset it once/);
    const reset = await request(app).post(`/api/tickets/${path}/${row._id}/reset-pin`).set('Authorization', auth(true)).send({ pin: '654321' });
    expect(reset.status).toBe(200);
    const reveal = await request(app).post(`/api/tickets/${path}/${row._id}/reveal-pin`).set('Authorization', auth(true));
    expect(reveal.body.data.pin).toBe('654321');
    expect(await (await (model as any).findById(row._id).select('+pin')).comparePin('654321')).toBe(true);
  });
});

it('deletes a stall and its staff while keeping its reporting identity', async () => {
  const { stall, event } = await setup();
  const operator = await MerchantOperator.create({ fullName: 'Till', merchantId: stall._id, eventId: event._id, loginCode: 'XYZ123', pin: '123456' });
  const res = await request(app).delete(`/api/tickets/merchants/${stall._id}`).set('Authorization', auth(true));
  expect(res.status).toBe(200);
  expect((await Merchant.findById(stall._id))?.status).toBe('suspended');
  expect((await MerchantOperator.findById(operator._id))?.isActive).toBe(false);
  expect((await request(app).get(`/api/tickets/merchants?eventId=${event._id}`).set('Authorization', auth(true))).body.data).toEqual([]);
});

it('blocks deleting a stall while an open table depends on it', async () => {
  const { stall, event } = await setup();
  await Table.create({ eventId: event._id, label: '1', openedBy: 'waiter:test', items: [
    { merchantId: stall._id, productId: '64c000000000000000000b01', name: 'Drink', unitPrice: 100, qty: 1, addedBy: 'waiter:test' },
  ] });
  const res = await request(app).delete(`/api/tickets/merchants/${stall._id}`).set('Authorization', auth(true));
  expect(res.status).toBe(409);
  expect((await Merchant.findById(stall._id))?.status).toBe('active');
});

it('keeps a waiter available while their open table needs service', async () => {
  const { event } = await setup();
  const waiter = await Waiter.create({ fullName: 'Floor', scope: 'organizer', vendorId, eventId: event._id, loginCode: 'FLO123', pin: '123456' });
  await Table.create({ eventId: event._id, label: '2', openedBy: String(waiter._id) });
  const res = await request(app).delete(`/api/tickets/waiters/${waiter._id}`).set('Authorization', auth(true));
  expect(res.status).toBe(409);
  expect((await Waiter.findById(waiter._id))?.isActive).toBe(true);
});

it('keeps a cashier available while a cash collection awaits confirmation', async () => {
  const { event } = await setup();
  const cashier = await Cashier.create({ fullName: 'Desk', scope: 'organizer', vendorId, eventId: event._id, loginCode: 'CAS123', pin: '123456' });
  await CashCollection.create({ eventId: event._id, cashierId: cashier._id, collectorId: '64c000000000000000000b01',
    cashierName: 'Desk', collectorName: 'Collector', amount: 100, clientTxnId: 'collection-1', status: 'pending' });
  const res = await request(app).delete(`/api/tickets/cashiers/${cashier._id}`).set('Authorization', auth(true));
  expect(res.status).toBe(409);
  expect((await Cashier.findById(cashier._id))?.isActive).toBe(true);
});
