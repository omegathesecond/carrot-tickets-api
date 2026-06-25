// api/src/routes/__tests__/gateOperators.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_A = '64b000000000000000000a01';
const VENDOR_B = '64b000000000000000000b02';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string }) {
  return jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId }, JWT_SECRET);
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('super-admin creates a platform-wide gate operator and gets credentials once', async () => {
  const res = await request(app).post('/api/tickets/gate-operators')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ fullName: 'Platform Gate', scope: 'platform' });
  expect(res.status).toBe(201);
  expect(res.body.data.loginCode).toMatch(/^\d{6}$/);
  expect(res.body.data.pin).toMatch(/^\d{6}$/);
  expect(res.body.data.operator.scope).toBe('platform');
});

it('organizer create is forced to their own vendor + organizer scope', async () => {
  const res = await request(app).post('/api/tickets/gate-operators')
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
    .send({ fullName: 'Org Gate', scope: 'platform', vendorId: VENDOR_B }); // attempts to escalate
  expect(res.status).toBe(201);
  expect(res.body.data.operator.scope).toBe('organizer');
  expect(res.body.data.operator.vendorId).toBe(VENDOR_A);
});

it('organizer lists only their own operators', async () => {
  await GateOperator.create({ fullName: 'A', loginCode: '810001', pin: '111111', scope: 'organizer', vendorId: VENDOR_A });
  await GateOperator.create({ fullName: 'B', loginCode: '810002', pin: '111111', scope: 'organizer', vendorId: VENDOR_B });
  const res = await request(app).get('/api/tickets/gate-operators')
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
  expect(res.body.data[0].vendorId).toBe(VENDOR_A);
});

it('organizer cannot reset-pin another vendor operator (404)', async () => {
  const other = await GateOperator.create({ fullName: 'B', loginCode: '810003', pin: '111111', scope: 'organizer', vendorId: VENDOR_B });
  const res = await request(app).post(`/api/tickets/gate-operators/${other._id}/reset-pin`)
    .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`).send({});
  expect(res.status).toBe(404);
});

it('a caller without manage_access is forbidden (403)', async () => {
  const t = jwt.sign({ app: 'tickets', userType: 'vendor', permissions: [], vendorId: VENDOR_A }, JWT_SECRET);
  const res = await request(app).get('/api/tickets/gate-operators').set('Authorization', `Bearer ${t}`);
  expect(res.status).toBe(403);
});
