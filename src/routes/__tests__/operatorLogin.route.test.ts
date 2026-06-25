// api/src/routes/__tests__/operatorLogin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedOperator } from '../../__tests__/helpers/fixtures';
import { GateOperator } from '@models/gateOperator.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('routes a reseller login to type=reseller', async () => {
  const seeded = await seedOperator({ pin: '123456', loginCode: '700001' });
  const res = await request(app).post('/api/operator/login').send({ loginCode: seeded.loginCode, pin: '123456' });
  expect(res.status).toBe(200);
  expect(res.body.data.type).toBe('reseller');
  expect(res.body.data.accessToken).toBeTruthy();
});

it('routes a gate login to type=gate with a tickets-scoped token', async () => {
  await GateOperator.create({ fullName: 'Gate', loginCode: '700002', pin: '654321', scope: 'platform' });
  const res = await request(app).post('/api/operator/login').send({ loginCode: '700002', pin: '654321' });
  expect(res.status).toBe(200);
  expect(res.body.data.type).toBe('gate');
  const decoded: any = jwt.verify(res.body.data.accessToken, JWT_SECRET);
  expect(decoded.app).toBe('tickets');
  expect(decoded.userType).toBe('gate-operator');
  expect(decoded.isSuperAdmin).toBe(true);
  expect(decoded.permissions).toEqual(expect.arrayContaining(['tickets:scan_tickets', 'tickets:view_scans']));
});

it('rejects an unknown login code', async () => {
  const res = await request(app).post('/api/operator/login').send({ loginCode: '999999', pin: '000000' });
  expect(res.status).toBe(401);
});
