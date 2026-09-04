// api/src/routes/__tests__/operatorLoginRegisterRole.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

const VENDOR = new mongoose.Types.ObjectId().toString();
const PIN = '123456';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedOperator(loginCode: string, grants: string[]) {
  await GateOperator.create({
    fullName: 'Desk Dumi', scope: 'organizer', vendorId: new mongoose.Types.ObjectId(VENDOR),
    eventIds: [], loginCode, pin: PIN, grants,
  });
}

/**
 * Register and Gate share one credential stack — the desk IS a gate operator
 * carrying the tag grant — but the POS opens a different screen for each, so
 * the login has to name the job rather than the collection the row lives in.
 */
describe('POST /api/operator/login — Register is its own role', () => {
  it('logs the tag-granted operator in as Register', async () => {
    await seedOperator('920001', [OperatorGrant.ISSUE_TAGS]);

    const res = await request(app).post('/api/operator/login').send({ loginCode: '920001', pin: PIN });

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('register');
    expect(res.body.data.operator.isRegisterDesk).toBe(true);
    expect(res.body.data.operator.grants).toEqual([OperatorGrant.ISSUE_TAGS]);
  });

  it('leaves a plain scanner as Gate', async () => {
    await seedOperator('920002', []);

    const res = await request(app).post('/api/operator/login').send({ loginCode: '920002', pin: PIN });

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('gate');
    expect(res.body.data.operator.isRegisterDesk).toBe(false);
  });
});
