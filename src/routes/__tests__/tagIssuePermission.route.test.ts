// api/src/routes/__tests__/tagIssuePermission.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const VENDOR = '64c000000000000000000a01';
const PIN = '123456';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** A real row → a real login → the token the route actually sees. */
async function loginWith(grants: string[], loginCode: string) {
  await GateOperator.create({
    fullName: 'Tag Desk', scope: 'organizer', vendorId: new mongoose.Types.ObjectId(VENDOR),
    eventIds: [], loginCode, pin: PIN, grants,
  });
  return GateOperatorAuthService.login(loginCode, PIN);
}

describe('issuing a tag is its own capability, not a side effect of scanning', () => {
  it('403s a gate operator who has not been granted it', async () => {
    const { accessToken } = await loginWith([], '900001');

    const res = await request(app)
      .post('/api/tickets/scans/bind-band')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ticketId: '64c000000000000000000f01', bandUid: 'ABC123' });

    expect(res.status).toBe(403);
  });

  it('lets a granted gate operator past the permission gate', async () => {
    const { accessToken } = await loginWith([OperatorGrant.ISSUE_TAGS], '900002');

    const res = await request(app)
      .post('/api/tickets/scans/bind-band')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ticketId: '64c000000000000000000f01', bandUid: 'ABC123' });

    // The ticket doesn't exist, so this fails downstream — the point is that it
    // is no longer refused at the door.
    expect(res.status).not.toBe(403);
  });

  it('puts the granted permission in the token and leaves scanning intact', async () => {
    const { accessToken } = await loginWith([OperatorGrant.ISSUE_TAGS], '900003');
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64').toString());

    expect(payload.permissions).toContain(TicketsPermission.ISSUE_TAGS);
    expect(payload.permissions).toContain(TicketsPermission.SCAN_TICKETS);
  });

  it('refuses to store a grant that is not a real capability', async () => {
    // Two layers guard the token: the schema enum stops the value being
    // written, and grantedTicketsPermissions filters again at mint time in case
    // a row predates the check (covered in operatorGrants.test.ts).
    await expect(
      GateOperator.create({
        fullName: 'Sneaky', scope: 'organizer', vendorId: new mongoose.Types.ObjectId(VENDOR),
        eventIds: [], loginCode: '900004', pin: PIN, grants: ['tickets:manage_stock'],
      }),
    ).rejects.toThrow(/not a valid enum value/i);
  });
});
