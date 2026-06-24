import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { seedOperator } from '../../__tests__/helpers/fixtures';
import { ResellerCommissionWithdrawal } from '@models/resellerCommissionWithdrawal.model';
import { TicketSale } from '@models/ticketSale.model';
import jwt from 'jsonwebtoken';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function signNonSuperAdminToken(): string {
  return jwt.sign(
    {
      app: 'tickets',
      vendorId: 'regular-vendor-id',
      userType: 'vendor',
      isSuperAdmin: false,
      role: 'owner',
      permissions: [],
    },
    JWT_SECRET,
  );
}

async function seedWithdrawal(resellerId: string, operatorId: string, status: string = 'requested') {
  return ResellerCommissionWithdrawal.create({
    resellerId: new mongoose.Types.ObjectId(resellerId),
    amount: 50,
    status,
    requestedBy: operatorId,
    requestedAt: new Date(),
    snapshotAt: new Date(),
  });
}

async function seedCompletedSale(resellerId: string, operatorId: string, amount: number) {
  return TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    quantity: 1,
    totalAmount: amount * 10,
    paymentMethod: 'cash',
    paymentStatus: 'completed',
    soldBy: new mongoose.Types.ObjectId(operatorId),
    soldByType: 'ResellerOperator',
    resellerId: new mongoose.Types.ObjectId(resellerId),
    fundsCustody: 'carrot',
    resellerCommissionAmount: amount,
    commissionWithdrawn: false,
    soldAt: new Date(),
  });
}

it('non-super-admin (or no token) is rejected → 401/403', async () => {
  const noAuth = await request(app).get('/api/admin/withdrawals');
  expect(noAuth.status).toBe(401);

  const nonAdmin = signNonSuperAdminToken();
  const restricted = await request(app)
    .get('/api/admin/withdrawals')
    .set('Authorization', `Bearer ${nonAdmin}`);
  expect(restricted.status).toBe(403);
});

it('lists all withdrawals (optionally filtered by status)', async () => {
  const token = signSuperAdminToken();
  const { resellerId, operator } = await seedOperator();

  await seedWithdrawal(resellerId, operator._id.toString(), 'requested');
  await seedWithdrawal(resellerId, operator._id.toString(), 'approved');

  const all = await request(app)
    .get('/api/admin/withdrawals')
    .set('Authorization', `Bearer ${token}`);
  expect(all.status).toBe(200);
  expect(Array.isArray(all.body.data)).toBe(true);

  const filtered = await request(app)
    .get('/api/admin/withdrawals?status=approved')
    .set('Authorization', `Bearer ${token}`);
  expect(filtered.status).toBe(200);
  expect(filtered.body.data.every((w: any) => w.status === 'approved')).toBe(true);
});

it('lists withdrawals for a specific reseller', async () => {
  const token = signSuperAdminToken();
  const { resellerId, operator } = await seedOperator();

  await seedWithdrawal(resellerId, operator._id.toString());

  const res = await request(app)
    .get(`/api/admin/resellers/${resellerId}/withdrawals`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.data)).toBe(true);
  expect(res.body.data.every((w: any) => w.resellerId === resellerId)).toBe(true);
});

it('approve → mark-paid happy path: status becomes paid and sales are stamped', async () => {
  const token = signSuperAdminToken();
  const { resellerId, operator } = await seedOperator();
  const operatorId = operator._id.toString();

  // Seed a sale so commissionWithdrawn can be stamped
  await seedCompletedSale(resellerId, operatorId, 50);

  const w = await seedWithdrawal(resellerId, operatorId, 'requested');
  const wid = (w._id as mongoose.Types.ObjectId).toString();

  // Approve
  const approveRes = await request(app)
    .post(`/api/admin/withdrawals/${wid}/approve`)
    .set('Authorization', `Bearer ${token}`);
  expect(approveRes.status).toBe(200);
  expect(approveRes.body.data.status).toBe('approved');

  // Mark paid
  const paidRes = await request(app)
    .post(`/api/admin/withdrawals/${wid}/mark-paid`)
    .set('Authorization', `Bearer ${token}`)
    .send({ paymentReference: 'REF-001' });
  expect(paidRes.status).toBe(200);
  expect(paidRes.body.data.status).toBe('paid');
  expect(paidRes.body.data.paymentReference).toBe('REF-001');

  // Balance is now 0 — all sales are stamped commissionWithdrawn: true
  const { WithdrawalService } = await import('@services/withdrawal.service');
  const balance = await WithdrawalService.availableCommission(resellerId);
  expect(balance).toBe(0);
});

it('approve → reject happy path: status becomes rejected', async () => {
  const token = signSuperAdminToken();
  const { resellerId, operator } = await seedOperator();

  const w = await seedWithdrawal(resellerId, operator._id.toString(), 'requested');
  const wid = (w._id as mongoose.Types.ObjectId).toString();

  const approveRes = await request(app)
    .post(`/api/admin/withdrawals/${wid}/approve`)
    .set('Authorization', `Bearer ${token}`);
  expect(approveRes.status).toBe(200);

  const rejectRes = await request(app)
    .post(`/api/admin/withdrawals/${wid}/reject`)
    .set('Authorization', `Bearer ${token}`)
    .send({ notes: 'Insufficient info' });
  expect(rejectRes.status).toBe(200);
  expect(rejectRes.body.data.status).toBe('rejected');
  expect(rejectRes.body.data.notes).toBe('Insufficient info');
});

it('returns 404 for unknown withdrawal id on approve', async () => {
  const token = signSuperAdminToken();
  const missingId = new mongoose.Types.ObjectId().toString();

  const res = await request(app)
    .post(`/api/admin/withdrawals/${missingId}/approve`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});

it('returns 404 when trying to mark-paid a rejected withdrawal', async () => {
  const token = signSuperAdminToken();
  const { resellerId, operator } = await seedOperator();

  const w = await seedWithdrawal(resellerId, operator._id.toString(), 'rejected');
  const wid = (w._id as mongoose.Types.ObjectId).toString();

  const res = await request(app)
    .post(`/api/admin/withdrawals/${wid}/mark-paid`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});
