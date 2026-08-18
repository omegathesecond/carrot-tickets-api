// api/src/routes/__tests__/merchantOperatorAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function superAdminToken() {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: true,
  }, JWT_SECRET);
}

/** A caller carrying no manage_access permission at all. */
function unprivilegedToken() {
  return jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [] }, JWT_SECRET);
}

async function seedMerchant(): Promise<{ merchantId: string; eventId: string }> {
  const eventId = new mongoose.Types.ObjectId();
  const merchant = await Merchant.create({ name: 'Fixture Stall', eventId, commissionPercent: 10 });
  return { merchantId: String(merchant._id), eventId: String(eventId) };
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('creating an operator returns the credentials exactly once, and the list never leaks the pin', async () => {
  const { merchantId } = await seedMerchant();
  const agent = request(app);
  const admin = superAdminToken();

  const res = await agent.post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Thabo Dlamini' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.pin).toBeUndefined();
  expect(res.body.data.operator.merchantId).toBe(merchantId);

  const list = await agent.get(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`);
  expect(list.status).toBe(200);
  expect(list.body.data.operators).toHaveLength(1);
  expect(list.body.data.operators[0].pin).toBeUndefined();
  expect(list.body.data.operators[0].loginCode).toBe(res.body.data.loginCode);
});

it('inherits eventId from the stall rather than the body', async () => {
  const { merchantId, eventId: stallEventId } = await seedMerchant();
  const admin = superAdminToken();

  const res = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Sipho', eventId: new mongoose.Types.ObjectId().toString() });
  expect(res.status).toBe(201);
  expect(res.body.data.operator.eventId).toBe(stallEventId);

  // Persisted state, not just the response shape.
  const stored = await MerchantOperator.findById(res.body.data.operator._id);
  expect(String(stored!.eventId)).toBe(stallEventId);
});

it('404s for a stall that does not exist — never silently creates an orphan operator', async () => {
  const admin = superAdminToken();
  const res = await request(app).post(`/api/tickets/merchants/${new mongoose.Types.ObjectId()}/operators`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Nobody' });
  expect(res.status).toBe(404);
  expect(await MerchantOperator.countDocuments({})).toBe(0);
});

it('list is scoped to the stall — another stall\'s operators never leak in', async () => {
  const a = await seedMerchant();
  const b = await seedMerchant();
  const admin = superAdminToken();

  await request(app).post(`/api/tickets/merchants/${a.merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`).send({ fullName: 'A Operator' });
  await request(app).post(`/api/tickets/merchants/${b.merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`).send({ fullName: 'B Operator' });

  const res = await request(app).get(`/api/tickets/merchants/${a.merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`);
  expect(res.status).toBe(200);
  expect(res.body.data.operators).toHaveLength(1);
  expect(res.body.data.operators[0].fullName).toBe('A Operator');
});

it('PATCH updates fullName and isActive', async () => {
  const { merchantId } = await seedMerchant();
  const admin = superAdminToken();

  const created = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`).send({ fullName: 'Original Name' });
  const operatorId = created.body.data.operator._id;

  const res = await request(app).patch(`/api/tickets/merchant-operators/${operatorId}`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Renamed', isActive: false });
  expect(res.status).toBe(200);
  expect(res.body.data.operator.fullName).toBe('Renamed');
  expect(res.body.data.operator.isActive).toBe(false);

  const stored = await MerchantOperator.findById(operatorId);
  expect(stored!.fullName).toBe('Renamed');
  expect(stored!.isActive).toBe(false);
});

it('PATCH 404s for an operator that does not exist', async () => {
  const admin = superAdminToken();
  const res = await request(app).patch(`/api/tickets/merchant-operators/${new mongoose.Types.ObjectId()}`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Ghost' });
  expect(res.status).toBe(404);
});

it('reset-pin issues a fresh pin that actually verifies, and clears lockout', async () => {
  const { merchantId } = await seedMerchant();
  const admin = superAdminToken();

  const created = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`).send({ fullName: 'Reset Me' });
  const operatorId = created.body.data.operator._id;
  const originalPin = created.body.data.pin;

  await MerchantOperator.updateOne({ _id: operatorId }, { failedPinAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) });

  const res = await request(app).post(`/api/tickets/merchant-operators/${operatorId}/reset-pin`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ pin: '424242' });
  expect(res.status).toBe(200);
  expect(res.body.data.operatorId).toBe(operatorId);
  expect(res.body.data.pin).toBe('424242');
  expect(res.body.data.pin).not.toBe(originalPin);

  const op = await MerchantOperator.findById(operatorId).select('+pin');
  expect(await op!.comparePin('424242')).toBe(true);
  expect(op!.failedPinAttempts).toBe(0);
  expect(op!.lockedUntil).toBeNull();
});

it('a caller without manage_access is forbidden (403) on every route', async () => {
  const { merchantId } = await seedMerchant();
  const t = unprivilegedToken();

  const list = await request(app).get(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${t}`);
  expect(list.status).toBe(403);

  const create = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${t}`).send({ fullName: 'X' });
  expect(create.status).toBe(403);
});

it('no token at all → 401', async () => {
  const { merchantId } = await seedMerchant();
  const res = await request(app).get(`/api/tickets/merchants/${merchantId}/operators`);
  expect(res.status).toBe(401);
});
