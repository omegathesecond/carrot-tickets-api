// api/src/routes/__tests__/gateGrantRevocation.route.test.ts
//
// A gate operator's permissions — the SCANNER role set plus the per-person
// grants such as issue_tags — were baked into the JWT at login and trusted
// verbatim by requireTicketsPermission. Removing a grant through PATCH
// /gate-operators/:id {grants:[]} therefore changed nothing until the person
// next logged in, up to 7 days later: verified live, the old token still
// passed the ISSUE_TAGS gate on bind-band. The permission set is now
// re-resolved from the row on every gate request.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

const VENDOR = '64c000000000000000000a01';
const PIN = '123456';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 500;
const nextLoginCode = () => `4KZ${__loginCodeSeq++}`;

const organizerToken = () => jwt.sign({
  app: 'tickets', userType: 'vendor', role: 'tickets_owner', vendorId: VENDOR,
  permissions: ['tickets:manage_access'], isSuperAdmin: false,
}, JWT_SECRET);

/** A real row → a real login → the token the POS actually holds. */
async function loginWith(grants: string[]) {
  const loginCode = nextLoginCode();
  const operator = await GateOperator.create({
    fullName: 'Tag Desk', scope: 'organizer', vendorId: new mongoose.Types.ObjectId(VENDOR),
    eventIds: [], loginCode, pin: PIN, grants,
  });
  const { accessToken } = await GateOperatorAuthService.login(loginCode, PIN);
  return { operator, accessToken };
}

const bindBand = (token: string) =>
  request(app).post('/api/tickets/scans/bind-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ ticketId: '64c000000000000000000f01', bandUid: 'ABC123' });

it('a granted operator passes the ISSUE_TAGS gate (the control)', async () => {
  const { accessToken } = await loginWith([OperatorGrant.ISSUE_TAGS]);
  // The ticket does not exist, so this fails downstream — the point is that it
  // is not refused at the door.
  expect((await bindBand(accessToken)).status).not.toBe(403);
});

it('removing the grant revokes the SAME token at once, without a re-login', async () => {
  const { operator, accessToken } = await loginWith([OperatorGrant.ISSUE_TAGS]);
  expect((await bindBand(accessToken)).status).not.toBe(403);

  const patch = await request(app).patch(`/api/tickets/gate-operators/${operator._id}`)
    .set('Authorization', `Bearer ${organizerToken()}`)
    .send({ grants: [] });
  expect(patch.status).toBe(200);

  expect((await bindBand(accessToken)).status).toBe(403);

  const registry = await request(app).get(`/api/tickets/events/${new mongoose.Types.ObjectId()}/tags/registry`)
    .set('Authorization', `Bearer ${accessToken}`);
  expect(registry.status).toBe(403);
});

it('a still-granted operator keeps working while a colleague is revoked', async () => {
  const keeps = await loginWith([OperatorGrant.ISSUE_TAGS]);
  const loses = await loginWith([OperatorGrant.ISSUE_TAGS]);
  await GateOperator.updateOne({ _id: loses.operator._id }, { $set: { grants: [] } });

  expect((await bindBand(loses.accessToken)).status).toBe(403);
  expect((await bindBand(keeps.accessToken)).status).not.toBe(403);
});

it('granting AFTER login widens the same token too — the row is the source of truth', async () => {
  const { operator, accessToken } = await loginWith([]);
  expect((await bindBand(accessToken)).status).toBe(403);

  await GateOperator.updateOne({ _id: operator._id }, { $set: { grants: [OperatorGrant.ISSUE_TAGS] } });

  expect((await bindBand(accessToken)).status).not.toBe(403);
});

it('a deactivated operator is refused at the permission gate, whatever the token says', async () => {
  const { operator, accessToken } = await loginWith([OperatorGrant.ISSUE_TAGS]);
  await GateOperator.updateOne({ _id: operator._id }, { $set: { isActive: false } });

  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ ticketId: '64c000000000000000000f01' });
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('Operator deactivated');
});

it('a token naming a row that no longer exists is refused the same way', async () => {
  const { operator, accessToken } = await loginWith([]);
  await GateOperator.deleteOne({ _id: operator._id });

  const res = await request(app).get('/api/tickets/events')
    .set('Authorization', `Bearer ${accessToken}`);
  expect(res.status).toBe(401);
});
