import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { seedReseller } from '../../__tests__/helpers/fixtures';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

it('super-admin creates a reseller → 201; no-token request → 401', async () => {
  const admin = signSuperAdminToken();

  const created = await request(app)
    .post('/api/admin/resellers')
    .set('Authorization', `Bearer ${admin}`)
    .send({ businessName: 'Shoprite', commissionPercent: 6 });
  expect(created.status).toBe(201);

  const noauth = await request(app)
    .post('/api/admin/resellers')
    .send({ businessName: 'X' });
  expect(noauth.status).toBe(401);
});

it('issues an operator with a login code + PIN', async () => {
  const superAdminToken = signSuperAdminToken();
  const { hubId } = await seedReseller();
  const res = await request(app)
    .post(`/api/admin/hubs/${hubId}/operators`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ fullName: 'New Till', role: 'reseller_operator' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^\d{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.pin).toBeUndefined();
});

it('resets an operator PIN', async () => {
  const superAdminToken = signSuperAdminToken();
  const { hubId } = await seedReseller();
  const created = await request(app)
    .post(`/api/admin/hubs/${hubId}/operators`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ fullName: 'Reset Me', role: 'reseller_operator' });
  const operatorId = created.body.data.operator._id;

  const res = await request(app)
    .post(`/api/admin/operators/${operatorId}/reset-pin`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send({ pin: '424242' });
  expect(res.status).toBe(200);
  expect(res.body.data.pin).toBe('424242');

  const op = await ResellerOperator.findById(operatorId).select('+pin');
  expect(await op!.comparePin('424242')).toBe(true);
});
