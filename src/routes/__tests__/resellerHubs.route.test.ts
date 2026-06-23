import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedOperator, seedReseller } from '../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

async function tokenFor(role: string) {
  const seeded = await seedOperator({ role, pin: '123456' });
  const login = await request(app).post('/api/reseller/auth/login').send({ loginCode: seeded.loginCode, pin: '123456' });
  return { token: login.body.data.accessToken as string, ...seeded };
}

it('admin lists hubs in their reseller; hub_manager sees only their hub', async () => {
  const admin = await tokenFor('reseller_admin');
  const res = await request(app).get('/api/reseller/hubs').set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(200);
  for (const h of res.body.data) expect(h.resellerId).toBe(admin.resellerId);

  const mgr = await tokenFor('reseller_hub_manager');
  const res2 = await request(app).get('/api/reseller/hubs').set('Authorization', `Bearer ${mgr.token}`);
  expect(res2.status).toBe(200);
  for (const h of res2.body.data) expect(h._id).toBe(mgr.hubId);
});

it('a plain operator cannot view hubs (403)', async () => {
  const op = await tokenFor('reseller_operator');
  const res = await request(app).get('/api/reseller/hubs').set('Authorization', `Bearer ${op.token}`);
  expect(res.status).toBe(403);
});

it('admin gets analytics for own hub; cross-reseller hub → 404', async () => {
  const admin = await tokenFor('reseller_admin');
  const ok = await request(app).get(`/api/reseller/hubs/${admin.hubId}/analytics`).set('Authorization', `Bearer ${admin.token}`);
  expect(ok.status).toBe(200);
  expect(ok.body.data.hubId).toBe(admin.hubId);

  const other = await seedReseller();
  const denied = await request(app).get(`/api/reseller/hubs/${other.hubId}/analytics`).set('Authorization', `Bearer ${admin.token}`);
  expect(denied.status).toBe(404);
});

it('operator list accepts a hubId filter within scope', async () => {
  const admin = await tokenFor('reseller_admin');
  const res = await request(app).get(`/api/reseller/operators?hubId=${admin.hubId}`).set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(200);
  for (const o of res.body.data) expect(o.hubId).toBe(admin.hubId);

  // hub_manager passing a foreign hub → 403
  const mgr = await tokenFor('reseller_hub_manager');
  const foreign = await seedReseller();
  const denied = await request(app).get(`/api/reseller/operators?hubId=${foreign.hubId}`).set('Authorization', `Bearer ${mgr.token}`);
  expect(denied.status).toBe(403);
});
