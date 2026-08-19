// api/src/routes/__tests__/gateOperatorActivity.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';
const OTHER = '64c000000000000000000b02';

const token = (perms: string[], vendorId = VENDOR) =>
  jwt.sign(
    { app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: perms, isSuperAdmin: false, vendorId },
    JWT_SECRET,
  );

async function operator(vendorId = VENDOR, loginCode = '930001') {
  return GateOperator.create({
    fullName: 'Gate Gugu', scope: 'organizer', vendorId: new mongoose.Types.ObjectId(vendorId),
    eventIds: [], loginCode, pin: '123456',
  } as any);
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('403s without manage_access', async () => {
  const op = await operator();
  const res = await request(app)
    .get(`/api/tickets/gate-operators/${op._id}/activity`)
    .set('Authorization', `Bearer ${token(['tickets:view_events'])}`);
  expect(res.status).toBe(403);
});

it("404s another organizer's operator rather than reporting on them", async () => {
  const op = await operator(OTHER, '930002');
  const res = await request(app)
    .get(`/api/tickets/gate-operators/${op._id}/activity`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`);
  expect(res.status).toBe(404);
});

it('reports an idle operator as zero rather than failing', async () => {
  const op = await operator();
  const res = await request(app)
    .get(`/api/tickets/gate-operators/${op._id}/activity`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`);

  expect(res.status).toBe(200);
  expect(res.body.data.summary).toMatchObject({ scans: 0, admitted: 0, refused: 0, tagsRegistered: 0 });
  expect(res.body.data.recent).toEqual([]);
});

it('never returns the PIN hash with the operator', async () => {
  const op = await operator();
  const res = await request(app)
    .get(`/api/tickets/gate-operators/${op._id}/activity`)
    .set('Authorization', `Bearer ${token(['tickets:manage_access'])}`);

  expect(res.body.data.operator).not.toHaveProperty('pin');
});
