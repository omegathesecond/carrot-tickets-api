import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { WristbandDesign } from '@models/wristbandDesign.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const EVENT_A = new mongoose.Types.ObjectId().toHexString();

function token(opts: { isSuperAdmin?: boolean; permissions?: string[] } = {}) {
  return jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: opts.permissions ?? [], isSuperAdmin: !!opts.isSuperAdmin,
    vendorId: new mongoose.Types.ObjectId().toHexString() }, JWT_SECRET);
}

const TEMPLATE = { key: 'a4-10up-25mm', pageWidthMm: 210, pageHeightMm: 297, bandWidthMm: 254, bandHeightMm: 25.4, marginTopMm: 12, marginLeftMm: 8, gapYMm: 2, bandsPerSheet: 10, tabZoneMm: 20 };

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('super-admin creates, lists, updates, deletes a design', async () => {
  const auth = { Authorization: `Bearer ${token({ isSuperAdmin: true })}` };

  const created = await request(app).post('/api/tickets/wristband-designs').set(auth)
    .send({ eventId: EVENT_A, name: 'VIP', sheetTemplate: TEMPLATE, designJson: { background: '#fff', elements: [] } });
  expect(created.status).toBe(201);
  const id = created.body.data._id;

  const listed = await request(app).get(`/api/tickets/wristband-designs?eventId=${EVENT_A}`).set(auth);
  expect(listed.status).toBe(200);
  expect(listed.body.data).toHaveLength(1);

  const updated = await request(app).put(`/api/tickets/wristband-designs/${id}`).set(auth)
    .send({ name: 'VIP v2', designJson: { background: '#000', elements: [] } });
  expect(updated.status).toBe(200);
  expect(updated.body.data.name).toBe('VIP v2');

  const deleted = await request(app).delete(`/api/tickets/wristband-designs/${id}`).set(auth);
  expect(deleted.status).toBe(200);
  expect(await WristbandDesign.countDocuments()).toBe(0);
});

it('team member with tickets:print_wristbands passes', async () => {
  const res = await request(app).get(`/api/tickets/wristband-designs?eventId=${EVENT_A}`)
    .set('Authorization', `Bearer ${token({ permissions: ['tickets:print_wristbands'] })}`);
  expect(res.status).toBe(200);
});

it('organizer without the permission is forbidden (403)', async () => {
  const res = await request(app).get(`/api/tickets/wristband-designs?eventId=${EVENT_A}`)
    .set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(403);
});

it('create rejects a missing eventId (400)', async () => {
  const res = await request(app).post('/api/tickets/wristband-designs')
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ name: 'x', sheetTemplate: TEMPLATE, designJson: {} });
  expect(res.status).toBe(400);
});

it('update of an unknown id 404s', async () => {
  const res = await request(app).put(`/api/tickets/wristband-designs/${new mongoose.Types.ObjectId()}`)
    .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
    .send({ name: 'x' });
  expect(res.status).toBe(404);
});
