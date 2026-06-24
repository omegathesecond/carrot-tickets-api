import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedOperator } from '../../__tests__/helpers/fixtures';
import { TicketSale } from '@models/ticketSale.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function tokenFor(role: string) {
  const seeded = await seedOperator({ role, pin: '123456' });
  const login = await request(app).post('/api/reseller/auth/login').send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

it('admin sees balance + can request; non-admin is forbidden', async () => {
  const admin = await tokenFor('reseller_admin');

  // Seed a completed carrot-custody sale so available balance > 0
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    ticketIds: [new mongoose.Types.ObjectId()],
    quantity: 1,
    totalAmount: 100,
    paymentMethod: 'keshless_wallet',
    paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(admin.resellerId),
    hubId: new mongoose.Types.ObjectId(admin.hubId),
    fundsCustody: 'carrot',
    resellerCommissionAmount: 10,
    commissionWithdrawn: false,
  });

  // GET /api/reseller/payouts as admin → 200 with { available, withdrawals }
  const getRes = await request(app)
    .get('/api/reseller/payouts')
    .set('Authorization', `Bearer ${admin.token}`);
  expect(getRes.status).toBe(200);
  expect(getRes.body.data).toHaveProperty('available');
  expect(getRes.body.data).toHaveProperty('withdrawals');
  expect(typeof getRes.body.data.available).toBe('number');
  expect(Array.isArray(getRes.body.data.withdrawals)).toBe(true);
  expect(getRes.body.data.available).toBeGreaterThan(0);

  // POST /api/reseller/payouts as admin with available balance → 201
  const postRes = await request(app)
    .post('/api/reseller/payouts')
    .set('Authorization', `Bearer ${admin.token}`);
  expect(postRes.status).toBe(201);
  expect(postRes.body.data.resellerId.toString()).toBe(admin.resellerId);

  // GET /api/reseller/payouts as operator token → 403
  const op = await tokenFor('reseller_operator');
  const forbiddenRes = await request(app)
    .get('/api/reseller/payouts')
    .set('Authorization', `Bearer ${op.token}`);
  expect(forbiddenRes.status).toBe(403);
});
