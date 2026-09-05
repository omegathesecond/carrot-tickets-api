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

  // The deactivated-waiter case above never reaches WaiterAuthService — the
  // controller's own `Waiter.exists({ isActive: true })` probe filters it out
  // first. This is the case that actually exercises the service's PIN compare,
  // and it is the one a login oracle would leak through: "wrong PIN" and "no
  // such code" must be the SAME string, or a caller can tell the two apart by
  // probing codes.
  it('refuses a wrong PIN with the same generic message as an unknown code', async () => {
    await hire();
    const wrongPin = await login('WTR001', '000000');
    const unknownCode = await login('NOSUCH', '000000');
    expect(wrongPin.status).toBe(401);
    expect(unknownCode.status).toBe(401);
    expect(wrongPin.body.message).toMatch(/invalid credentials/i);
    // Compare the two messages directly rather than each against the same
    // regex separately — the point is that they are INDISTINGUISHABLE to a
    // caller, not merely that both happen to be generic.
    expect(wrongPin.body.message).toBe(unknownCode.body.message);
  });

  it('locks out after repeated wrong PINs, and a correct login clears the counter', async () => {
    const waiter = await hire();
    for (let i = 0; i < 4; i++) {
      const res = await login('WTR001', '000000');
      expect(res.status).toBe(401);
    }
    const midway = await Waiter.findById(waiter._id);
    expect(midway!.failedPinAttempts).toBe(4);

    const ok = await login('WTR001', '123456');
    expect(ok.status).toBe(200);

    const cleared = await Waiter.findById(waiter._id);
    expect(cleared!.failedPinAttempts).toBe(0);
    expect(cleared!.lockedUntil).toBeNull();
  });
});
