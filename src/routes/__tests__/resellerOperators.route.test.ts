import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedOperator, seedReseller } from '../../__tests__/helpers/fixtures';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function tokenFor(role: string) {
  const seeded = await seedOperator({ role, pin: '123456' });
  const login = await request(app).post('/api/reseller/auth/login').send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

it('a hub manager lists only operators in their hub', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  await seedOperator({ resellerId: mgr.resellerId, hubId: mgr.hubId, role: 'reseller_operator' }); // same hub
  await seedOperator(); // different reseller/hub
  const res = await request(app).get('/api/reseller/operators').set('Authorization', `Bearer ${mgr.token}`);
  expect(res.status).toBe(200);
  for (const op of res.body.data) expect(op.hubId).toBe(mgr.hubId);
});

it('a plain operator cannot list operators (403)', async () => {
  const op = await tokenFor('reseller_operator');
  const res = await request(app).get('/api/reseller/operators').set('Authorization', `Bearer ${op.token}`);
  expect(res.status).toBe(403);
});

it('a hub manager issues an operator in their own hub', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const res = await request(app).post('/api/reseller/operators')
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({ fullName: 'Hired', role: 'reseller_operator' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.hubId).toBe(mgr.hubId);
});

it('a hub manager cannot mint a reseller_admin (403)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const res = await request(app).post('/api/reseller/operators')
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({ fullName: 'Boss', role: 'reseller_admin' });
  expect(res.status).toBe(403);
});

it('a hub manager cannot reset a PIN for an operator in another hub (404)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const other = await seedOperator(); // different hub
  const res = await request(app).post(`/api/reseller/operators/${other.operator._id}/reset-pin`)
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({});
  expect(res.status).toBe(404);
});

it('a reseller admin resets a PIN within their reseller', async () => {
  const admin = await tokenFor('reseller_admin');
  const target = await seedOperator({ resellerId: admin.resellerId, hubId: admin.hubId });
  const res = await request(app).post(`/api/reseller/operators/${target.operator._id}/reset-pin`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ pin: '787878' });
  expect(res.status).toBe(200);
  const op = await ResellerOperator.findById(target.operator._id).select('+pin');
  expect(await op!.comparePin('787878')).toBe(true);
});

it('a hub manager cannot reset-pin a same-hub reseller_admin (403)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const adminTarget = await seedOperator({ resellerId: mgr.resellerId, hubId: mgr.hubId, role: 'reseller_admin' });
  const res = await request(app).post(`/api/reseller/operators/${adminTarget.operator._id}/reset-pin`)
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({});
  expect(res.status).toBe(403);
});

it('a hub manager cannot deactivate a same-hub reseller_admin (403)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const adminTarget = await seedOperator({ resellerId: mgr.resellerId, hubId: mgr.hubId, role: 'reseller_admin' });
  const res = await request(app).patch(`/api/reseller/operators/${adminTarget.operator._id}`)
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({ isActive: false });
  expect(res.status).toBe(403);
});

it('a hub manager cannot escalate a same-hub operator to reseller_admin (403)', async () => {
  const mgr = await tokenFor('reseller_hub_manager');
  const target = await seedOperator({ resellerId: mgr.resellerId, hubId: mgr.hubId, role: 'reseller_operator' });
  const res = await request(app).patch(`/api/reseller/operators/${target.operator._id}`)
    .set('Authorization', `Bearer ${mgr.token}`)
    .send({ role: 'reseller_admin' });
  expect(res.status).toBe(403);
});

it('a reseller admin cannot create in another reseller\'s hub (403)', async () => {
  const admin = await tokenFor('reseller_admin');
  const other = await seedReseller();
  const res = await request(app).post('/api/reseller/operators')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ fullName: 'X', role: 'reseller_operator', hubId: other.hubId });
  expect(res.status).toBe(403);
});

it('reset-pin clears lockout state', async () => {
  const admin = await tokenFor('reseller_admin');
  const target = await seedOperator({ resellerId: admin.resellerId, hubId: admin.hubId });
  await ResellerOperator.updateOne(
    { _id: target.operator._id },
    { failedPinAttempts: 5, lockedUntil: new Date(Date.now() + 600000) }
  );
  const res = await request(app).post(`/api/reseller/operators/${target.operator._id}/reset-pin`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({});
  expect(res.status).toBe(200);
  const op = await ResellerOperator.findById(target.operator._id);
  expect(op!.failedPinAttempts).toBe(0);
  expect(op!.lockedUntil).toBeNull();
});
