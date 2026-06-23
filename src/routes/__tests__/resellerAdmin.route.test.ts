import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';

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
