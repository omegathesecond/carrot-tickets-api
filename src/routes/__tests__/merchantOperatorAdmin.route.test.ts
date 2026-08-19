// api/src/routes/__tests__/merchantOperatorAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Event } from '@models/event.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

const VENDOR_A = '64b000000000000000000a01';
const VENDOR_B = '64b000000000000000000b02';

function superAdminToken() {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: true,
  }, JWT_SECRET);
}

/** An ordinary organizer — MANAGE_ACCESS is on the OWNER role, not platform-staff-only. */
function organizerToken(vendorId: string) {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: false, vendorId,
  }, JWT_SECRET);
}

/** A caller carrying no manage_access permission at all. */
function unprivilegedToken() {
  return jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [] }, JWT_SECRET);
}

/** A real Event (not just a bare ObjectId) so ownership checks have something to load. */
async function seedEvent(vendorId: string) {
  return Event.create({
    name: 'Fixture Event',
    venue: 'Fixture Venue',
    eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000),
    endTime: new Date(Date.now() + 90000000),
    vendorId,
  });
}

async function seedMerchant(vendorId: string = VENDOR_A): Promise<{ merchantId: string; eventId: string }> {
  const event = await seedEvent(vendorId);
  const merchant = await Merchant.create({ name: 'Fixture Stall', eventId: event._id, commissionPercent: 10 });
  return { merchantId: String(merchant._id), eventId: String(event._id) };
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

it('create accepts a caller-supplied valid pin verbatim, and rejects a malformed one', async () => {
  const { merchantId } = await seedMerchant();
  const admin = superAdminToken();

  const withValidPin = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Valid Pin', pin: '135790' });
  expect(withValidPin.status).toBe(201);
  expect(withValidPin.body.data.pin).toBe('135790');
  const stored = await MerchantOperator.findById(withValidPin.body.data.operator._id).select('+pin');
  expect(await stored!.comparePin('135790')).toBe(true);

  const withBadPin = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`)
    .send({ fullName: 'Malformed Pin', pin: 'abc' });
  expect(withBadPin.status).toBe(201);
  // A malformed pin is NOT stored verbatim — the controller falls back to generatePin().
  expect(withBadPin.body.data.pin).not.toBe('abc');
  expect(withBadPin.body.data.pin).toMatch(/^\d{6}$/);
});

it('a caller without manage_access is forbidden (403) on list, create, PATCH and reset-pin', async () => {
  const { merchantId } = await seedMerchant();
  const admin = superAdminToken();
  const created = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${admin}`).send({ fullName: 'X' });
  const operatorId = created.body.data.operator._id;

  const t = unprivilegedToken();

  const list = await request(app).get(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${t}`);
  expect(list.status).toBe(403);

  const create = await request(app).post(`/api/tickets/merchants/${merchantId}/operators`)
    .set('Authorization', `Bearer ${t}`).send({ fullName: 'Y' });
  expect(create.status).toBe(403);

  const update = await request(app).patch(`/api/tickets/merchant-operators/${operatorId}`)
    .set('Authorization', `Bearer ${t}`).send({ fullName: 'Z' });
  expect(update.status).toBe(403);

  const resetPin = await request(app).post(`/api/tickets/merchant-operators/${operatorId}/reset-pin`)
    .set('Authorization', `Bearer ${t}`).send({});
  expect(resetPin.status).toBe(403);
});

it('no token at all → 401', async () => {
  const { merchantId } = await seedMerchant();
  const res = await request(app).get(`/api/tickets/merchants/${merchantId}/operators`);
  expect(res.status).toBe(401);
});

describe('cross-tenant IDOR — an organizer cannot touch another organizer\'s stall', () => {
  it('list 403s for a stall owned by a different organizer', async () => {
    const b = await seedMerchant(VENDOR_B);
    const res = await request(app).get(`/api/tickets/merchants/${b.merchantId}/operators`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`);
    expect(res.status).toBe(403);
  });

  it('create 403s for a stall owned by a different organizer, and creates nothing', async () => {
    const b = await seedMerchant(VENDOR_B);
    const res = await request(app).post(`/api/tickets/merchants/${b.merchantId}/operators`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
      .send({ fullName: 'Attacker Plant' });
    expect(res.status).toBe(403);
    expect(await MerchantOperator.countDocuments({ merchantId: b.merchantId })).toBe(0);
  });

  it('update 403s for an operator on a different organizer\'s stall, and leaves it unchanged', async () => {
    const b = await seedMerchant(VENDOR_B);
    const created = await request(app).post(`/api/tickets/merchants/${b.merchantId}/operators`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_B)}`)
      .send({ fullName: 'B\'s Own Operator' });
    const operatorId = created.body.data.operator._id;

    const res = await request(app).patch(`/api/tickets/merchant-operators/${operatorId}`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
      .send({ fullName: 'Hijacked Name', isActive: false });
    expect(res.status).toBe(403);

    const stored = await MerchantOperator.findById(operatorId);
    expect(stored!.fullName).toBe('B\'s Own Operator');
    expect(stored!.isActive).toBe(true);
  });

  it('reset-pin 403s for an operator on a different organizer\'s stall — the real pin still verifies (no takeover)', async () => {
    const b = await seedMerchant(VENDOR_B);
    const created = await request(app).post(`/api/tickets/merchants/${b.merchantId}/operators`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_B)}`)
      .send({ fullName: 'B\'s Till Person' });
    const operatorId = created.body.data.operator._id;
    const originalPin = created.body.data.pin;

    const res = await request(app).post(`/api/tickets/merchant-operators/${operatorId}/reset-pin`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
      .send({ pin: '999999' });
    expect(res.status).toBe(403);

    // The attacker's chosen pin was never applied — the ORIGINAL pin still verifies.
    const op = await MerchantOperator.findById(operatorId).select('+pin');
    expect(await op!.comparePin(originalPin)).toBe(true);
    expect(await op!.comparePin('999999')).toBe(false);
  });

  it('an organizer CAN manage their own stall\'s operators', async () => {
    const a = await seedMerchant(VENDOR_A);
    const res = await request(app).post(`/api/tickets/merchants/${a.merchantId}/operators`)
      .set('Authorization', `Bearer ${organizerToken(VENDOR_A)}`)
      .send({ fullName: 'Owner Managed' });
    expect(res.status).toBe(201);
  });

  it('a super-admin reaches every route regardless of vendor — the fix does not over-restrict', async () => {
    const b = await seedMerchant(VENDOR_B);
    const admin = superAdminToken();

    const created = await request(app).post(`/api/tickets/merchants/${b.merchantId}/operators`)
      .set('Authorization', `Bearer ${admin}`).send({ fullName: 'Admin Created' });
    expect(created.status).toBe(201);
    const operatorId = created.body.data.operator._id;

    const list = await request(app).get(`/api/tickets/merchants/${b.merchantId}/operators`)
      .set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(200);

    const update = await request(app).patch(`/api/tickets/merchant-operators/${operatorId}`)
      .set('Authorization', `Bearer ${admin}`).send({ fullName: 'Admin Renamed' });
    expect(update.status).toBe(200);

    const resetPin = await request(app).post(`/api/tickets/merchant-operators/${operatorId}/reset-pin`)
      .set('Authorization', `Bearer ${admin}`).send({ pin: '111222' });
    expect(resetPin.status).toBe(200);
  });
});
