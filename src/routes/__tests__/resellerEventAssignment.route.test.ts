// api/src/routes/__tests__/resellerEventAssignment.route.test.ts
//
// A reseller assigned to specific events sees and sells only those. The list
// filter is cosmetic on its own — the sale guard is what actually holds the
// line, since event ids are public (they sit in /event/<slug>-<24hex> URLs).
import request from 'supertest';

const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));

import app from '@/app';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { Reseller } from '@models/reseller.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { seedPublishedEvent, seedOperator } from '../../__tests__/helpers/fixtures';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

/** Logs a till in and returns its bearer token. */
async function tillToken(loginCode: string, pin: string): Promise<string> {
  const login = await request(app).post('/api/reseller/auth/login').send({ loginCode, pin });
  expect(login.status).toBe(200);
  return login.body.data.accessToken;
}

/** Logs the reseller OWNER in (email + password) and returns its bearer token. */
async function ownerToken(email: string, password: string): Promise<string> {
  const login = await request(app).post('/api/reseller/auth/owner-login').send({ email, password });
  expect(login.status).toBe(200);
  return login.body.data.accessToken;
}

/** A reseller assigned to `assigned`, plus a till, plus an event it may NOT touch. */
async function seedAssignedReseller() {
  const assigned = await seedPublishedEvent({ price: 100, capacity: 10 });
  const offLimits = await seedPublishedEvent({ price: 100, capacity: 10 });

  const { resellerId, loginCode, pin } = await seedOperator({ role: 'reseller_operator' });
  await Reseller.findByIdAndUpdate(resellerId, {
    eventIds: [new mongoose.Types.ObjectId(assigned.eventId)],
    email: `owner-${resellerId}@deltapay.co.sz`,
  });
  // Set through a document save so the password pre-save hook hashes it.
  const reseller = await Reseller.findById(resellerId);
  reseller!.password = 'Secret123!';
  await reseller!.save();

  return { assigned, offLimits, resellerId, loginCode, pin, email: `owner-${resellerId}@deltapay.co.sz` };
}

it('lists only the events the reseller is assigned to', async () => {
  const { assigned, offLimits, loginCode, pin } = await seedAssignedReseller();
  const token = await tillToken(loginCode, pin);

  const res = await request(app).get('/api/reseller/events').set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  const ids = (res.body.data.data ?? res.body.data.events ?? res.body.data).map((e: any) => String(e._id ?? e.id));
  expect(ids).toContain(assigned.eventId);
  expect(ids).not.toContain(offLimits.eventId);
});

it('narrows the OWNER login too, not just the till', async () => {
  const { assigned, offLimits, email } = await seedAssignedReseller();
  const token = await ownerToken(email, 'Secret123!');

  const res = await request(app).get('/api/reseller/events').set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  const ids = (res.body.data.data ?? res.body.data.events ?? res.body.data).map((e: any) => String(e._id ?? e.id));
  expect(ids).toContain(assigned.eventId);
  expect(ids).not.toContain(offLimits.eventId);
});

it('refuses ticket types for an event outside the assignment', async () => {
  const { assigned, offLimits, loginCode, pin } = await seedAssignedReseller();
  const token = await tillToken(loginCode, pin);

  const allowed = await request(app)
    .get(`/api/reseller/events/${assigned.eventId}/tickets`)
    .set('Authorization', `Bearer ${token}`);
  expect(allowed.status).toBe(200);

  const refused = await request(app)
    .get(`/api/reseller/events/${offLimits.eventId}/tickets`)
    .set('Authorization', `Bearer ${token}`);
  expect(refused.status).toBe(403);
});

it('refuses a SALE for an event outside the assignment', async () => {
  const { offLimits, loginCode, pin } = await seedAssignedReseller();
  await PaymentConfigService.update({ cashEnabled: true } as any);
  const token = await tillToken(loginCode, pin);

  const res = await request(app)
    .post('/api/reseller/sales')
    .set('Authorization', `Bearer ${token}`)
    .send({
      eventId: offLimits.eventId,
      ticketTypeId: offLimits.ticketTypeId,
      quantity: 1,
      paymentMethod: 'cash',
    });

  expect(res.status).toBe(403);
});

it('still sells an event that IS assigned', async () => {
  const { assigned, loginCode, pin } = await seedAssignedReseller();
  await PaymentConfigService.update({ cashEnabled: true } as any);
  const token = await tillToken(loginCode, pin);

  const res = await request(app)
    .post('/api/reseller/sales')
    .set('Authorization', `Bearer ${token}`)
    .send({
      eventId: assigned.eventId,
      ticketTypeId: assigned.ticketTypeId,
      quantity: 1,
      paymentMethod: 'cash',
    });

  expect(res.status).toBe(201);
});

it('leaves an unassigned reseller seeing everything, as before', async () => {
  const a = await seedPublishedEvent({ price: 100, capacity: 10 });
  const b = await seedPublishedEvent({ price: 100, capacity: 10 });
  const { loginCode, pin } = await seedOperator({ role: 'reseller_operator' });
  const token = await tillToken(loginCode, pin);

  const res = await request(app).get('/api/reseller/events').set('Authorization', `Bearer ${token}`);

  const ids = (res.body.data.data ?? res.body.data.events ?? res.body.data).map((e: any) => String(e._id ?? e.id));
  expect(ids).toEqual(expect.arrayContaining([a.eventId, b.eventId]));
});
