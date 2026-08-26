// api/src/routes/__tests__/resellerNoTagRegistration.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { ResellerPermission, ResellerRole } from '@interfaces/resellerPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const resellerToken = () => jwt.sign({
  scope: 'reseller', resellerId: 'r1', hubId: 'h1', operatorId: 'o1',
  role: ResellerRole.ADMIN, permissions: Object.values(ResellerPermission),
}, JWT_SECRET);

/**
 * A reseller is an EXTERNAL ticket outlet. The organizer's tags are the
 * organizer's — registering one is the Register desk's job, and an outlet must
 * not be able to put a tag into circulation at a show it does not run (client
 * requirement, 2026-08-20). The whole sell-a-band-at-the-door route is gone,
 * not merely permission-gated, so there is nothing left to grant by accident.
 */
describe('a reseller can no longer register tags', () => {
  it('404s the old sell-band route even for a fully-permissioned reseller', async () => {
    const res = await request(app)
      .post('/api/reseller/sales/sell-band')
      .set('Authorization', `Bearer ${resellerToken()}`)
      .send({
        eventId: '64c000000000000000000e01', ticketTypeId: '64c000000000000000000t01',
        bandUid: '04a22b1c', cashAmount: 0, clientTxnId: 'x1',
      });

    expect(res.status).toBe(404);
  });

  it('still lets them sell an ordinary ticket', async () => {
    // Reaches the handler and fails on the unknown event, NOT on the route
    // being missing — removing the band sale must not have taken sales with it.
    const res = await request(app)
      .post('/api/reseller/sales')
      .set('Authorization', `Bearer ${resellerToken()}`)
      .send({ eventId: '64c000000000000000000e01', ticketTypeId: '64c000000000000000000t01', quantity: 1, paymentMethod: 'cash' });

    expect(res.status).not.toBe(404);
  });
});
