import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { Reseller } from '@models/reseller.model';
import { ResellerHub } from '@models/resellerHub.model';
import { ResellerOperator } from '@models/resellerOperator.model';

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
