import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Waiter } from '@models/waiter.model';
import { WaiterPermission } from '@interfaces/waiter.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const hire = (over: Record<string, unknown> = {}) =>
  Waiter.create({
    fullName: 'Thabo', loginCode: 'WTR001', pin: '123456', scope: 'organizer',
    vendorId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId(),
    ...over,
  });

const login = (loginCode: string, pin: string) =>
  request(app).post('/api/operator/login').send({ loginCode, pin });

describe('a waiter logging into the POS', () => {
  it('answers type waiter so the POS opens the floor screen', async () => {
    await hire();
    const res = await login('WTR001', '123456');
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('waiter');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it('carries the default permissions but not settle', async () => {
    await hire();
    const res = await login('WTR001', '123456');
    const payload = JSON.parse(
      Buffer.from(res.body.data.accessToken.split('.')[1], 'base64').toString(),
    );
    expect(payload.permissions).toContain(WaiterPermission.MANAGE_TABLES);
    expect(payload.permissions).not.toContain(WaiterPermission.SETTLE_TABLES);
    expect(payload.eventId).toEqual(expect.any(String));
  });

  it('adds settle when the organizer granted it', async () => {
    await hire({ grants: [OperatorGrant.SETTLE_TABLES] });
    const res = await login('WTR001', '123456');
    const payload = JSON.parse(
      Buffer.from(res.body.data.accessToken.split('.')[1], 'base64').toString(),
    );
    expect(payload.permissions).toContain(WaiterPermission.SETTLE_TABLES);
  });

  it('refuses a deactivated waiter with the same generic message', async () => {
    await hire({ isActive: false });
    const res = await login('WTR001', '123456');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid credentials/i);
  });
});
