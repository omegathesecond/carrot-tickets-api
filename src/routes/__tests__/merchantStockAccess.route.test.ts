// Merged Task 3 + Task 7 tests:
//  - Task 3: permissions on `req.merchant` must be DERIVED from the operator
//    row on every request, never trusted from the JWT's own `permissions`
//    claim. Proven via a token that forges a grant the row doesn't carry, and
//    via a grant that stops working the moment it is revoked.
//  - Task 7: GET /api/merchant/stalls, the transfer screen's destination
//    list — the first route gated by MerchantPermission.MANAGE_STOCK, which
//    is what makes Task 3's derivation observable at all.
//
// Task 4's `seedStall` fixture doesn't exist yet, so `seedStall` below is a
// local stand-in that seeds a Merchant + a MerchantOperator carrying grants
// (mirroring merchantCharge.route.test.ts's seedMerchantAndFundedBand) —
// reused by every test in this file rather than duplicated per-test.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 920001;

// A token that CLAIMS manage_stock regardless of what the row actually
// carries. Authorization must come from the row, never this claim.
const forgedToken = (merchantId: string, eventId: string, merchantOperatorId: string) =>
  jwt.sign({
    scope: 'merchant', merchantId, merchantOperatorId, operatorName: 'Nomsa Shongwe',
    eventId, name: 'Sandwich Stall',
    permissions: [MerchantPermission.CHARGE, MerchantPermission.MANAGE_STOCK],
  }, JWT_SECRET);

async function seedStall(opts: { grants?: string[]; eventId?: string } = {}) {
  const grants = opts.grants ?? [OperatorGrant.MANAGE_STOCK];
  const eventId = opts.eventId ?? (await seedPublishedEvent({})).eventId;
  const merchant = await Merchant.create({ name: 'Sandwich Stall', eventId });
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: merchant._id, eventId,
    loginCode: String(seq++), pin: '111111', grants,
  });
  return {
    eventId: String(eventId),
    merchantId: String(merchant._id),
    operatorId: String(operator._id),
    auth: `Bearer ${forgedToken(String(merchant._id), String(eventId), String(operator._id))}`,
  };
}

it('refuses a token claiming a grant the row does not carry', async () => {
  const s = await seedStall({ grants: [] });

  const res = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);

  expect(res.status).toBe(403);
});

it('stops honouring a grant as soon as it is revoked', async () => {
  const s = await seedStall({ grants: [OperatorGrant.MANAGE_STOCK] });

  const before = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);
  expect(before.status).toBe(200);

  await MerchantOperator.updateOne({ _id: s.operatorId }, { $set: { grants: [] } });

  const after = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);
  expect(after.status).toBe(403);
});

describe('GET /api/merchant/stalls', () => {
  it('lists the other active stalls at this event, by name', async () => {
    const s = await seedStall({});
    await Merchant.create({ name: 'Drinks Stall', eventId: s.eventId });
    await Merchant.create({ name: 'Closed Stall', eventId: s.eventId, status: 'suspended' });
    const other = await seedPublishedEvent({});
    await Merchant.create({ name: 'Other Event Stall', eventId: other.eventId });

    const res = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.stalls.map((x: any) => x.name)).toEqual(['Drinks Stall']);
  });

  it('refuses a stall operator without the grant', async () => {
    const s = await seedStall({ grants: [] });

    const res = await request(app).get('/api/merchant/stalls').set('Authorization', s.auth);

    expect(res.status).toBe(403);
  });
});
