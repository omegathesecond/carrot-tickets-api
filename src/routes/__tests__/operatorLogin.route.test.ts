// api/src/routes/__tests__/operatorLogin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedOperator, seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { GateOperator } from '@models/gateOperator.model';
import { Merchant } from '@models/merchant.model';
import mongoose from 'mongoose';

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

it('routes a merchant login to type=merchant with a merchant-scoped token carrying eventName', async () => {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({
    name: 'Fixture Merchant', eventId, commissionPercent: 5, loginCode: '700003', pin: '445566',
  });
  const res = await request(app).post('/api/operator/login').send({ loginCode: '700003', pin: '445566' });
  expect(res.status).toBe(200);
  expect(res.body.data.type).toBe('merchant');
  expect(res.body.data.operator.merchantId).toBe(String(merchant._id));
  expect(res.body.data.operator.eventId).toBe(String(eventId));
  // The app's vendor header reads this instead of showing a raw eventId.
  expect(res.body.data.operator.eventName).toBe('Snapshot Test Event');

  const decoded: any = jwt.verify(res.body.data.accessToken, JWT_SECRET);
  expect(decoded.scope).toBe('merchant');
  expect(decoded.merchantId).toBe(String(merchant._id));
  expect(decoded.eventId).toBe(String(eventId));
  expect(decoded.eventName).toBe('Snapshot Test Event');
  expect(decoded.permissions).toEqual(['merchant:charge']);
});

it('merchant login still succeeds (with no eventName) when the event was deleted after the merchant was created', async () => {
  const { eventId } = await seedPublishedEvent({});
  const merchant = await Merchant.create({
    name: 'Orphaned Merchant', eventId, commissionPercent: 0, loginCode: '700004', pin: '778899',
  });
  await mongoose.model('Event').deleteOne({ _id: eventId });

  const res = await request(app).post('/api/operator/login').send({ loginCode: '700004', pin: '778899' });
  expect(res.status).toBe(200);
  expect(res.body.data.operator.merchantId).toBe(String(merchant._id));
  expect(res.body.data.operator.eventName).toBeUndefined();
});

it('rejects an unknown login code', async () => {
  const res = await request(app).post('/api/operator/login').send({ loginCode: '999999', pin: '000000' });
  expect(res.status).toBe(401);
});

it('rejects NoSQL injection: both loginCode and pin are operator objects', async () => {
  const res = await request(app)
    .post('/api/operator/login')
    .send({ loginCode: { $ne: null }, pin: { $ne: null } });
  expect(res.status).toBe(400);
});

it('rejects NoSQL injection: object loginCode with string pin', async () => {
  const res = await request(app)
    .post('/api/operator/login')
    .send({ loginCode: { $ne: null }, pin: '123456' });
  expect(res.status).toBe(400);
});
