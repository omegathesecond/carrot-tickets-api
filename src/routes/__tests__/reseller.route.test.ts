import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { TicketSale } from '@models/ticketSale.model';
import mongoose from 'mongoose';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('login then list events; vendor route stays blocked', async () => {
  const r = await Reseller.create({ businessName: 'PnP', commissionPercent: null });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'CBD' });
  await ResellerOperator.create({ hubId: hub._id, resellerId: r._id, fullName: 'Op',
    phoneNumber: '+26878222222', password: 'secret123', role: 'reseller_operator' });

  const login = await request(app).post('/api/reseller/auth/login')
    .send({ identifier: '+26878222222', password: 'secret123' });
  expect(login.status).toBe(200);
  const token = login.body.data.accessToken;

  const events = await request(app).get('/api/reseller/events').set('Authorization', `Bearer ${token}`);
  expect(events.status).toBe(200);

  // reseller token cannot hit a vendor-only endpoint
  const blocked = await request(app).get('/api/tickets/events').set('Authorization', `Bearer ${token}`);
  expect([401, 403]).toContain(blocked.status);
});

/**
 * Regression test for the getSales soldByType filter bug.
 * The write path persists 'ResellerOperator' (enum value) but the original
 * filter used 'reseller-operator' (raw param value), causing GET /api/reseller/sales
 * to always return empty results even when matching sales exist.
 */
it('GET /api/reseller/sales returns sales created by this operator', async () => {
  const r = await Reseller.create({ businessName: 'SalesTest Reseller', commissionPercent: 10 });
  const hub = await ResellerHub.create({ resellerId: r._id, name: 'Sales Hub' });
  const operator = await ResellerOperator.create({
    hubId: hub._id,
    resellerId: r._id,
    fullName: 'Sales Op',
    phoneNumber: '+26878333333',
    password: 'secret123',
    role: 'reseller_operator',
  });

  const login = await request(app).post('/api/reseller/auth/login')
    .send({ identifier: '+26878333333', password: 'secret123' });
  expect(login.status).toBe(200);
  const token = login.body.data.accessToken;

  // Seed a TicketSale with the persisted enum value that the write path stores.
  const eventId = new mongoose.Types.ObjectId();
  const vendorId = new mongoose.Types.ObjectId();
  await TicketSale.create({
    eventId,
    vendorId,
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 100,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.COMPLETED,
    soldBy: operator._id,
    soldByType: 'ResellerOperator',  // persisted enum value — must match filter
    resellerId: r._id,
    hubId: hub._id,
  });

  const res = await request(app)
    .get('/api/reseller/sales')
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.data.pagination.total).toBe(1);
  expect(res.body.data.data).toHaveLength(1);
  expect(res.body.data.data[0].soldByType).toBe('ResellerOperator');
});
