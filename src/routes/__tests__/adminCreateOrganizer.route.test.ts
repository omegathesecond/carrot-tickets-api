import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe('POST /api/tickets/admin/organizers', () => {
  it('super-admin creates a verified transport operator', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ businessName: 'Kombi Co', phoneNumber: '+268760000009', password: 'secret1', operatorType: 'transport' });
    expect(res.status).toBe(201);
    const v = await Vendor.findOne({ phoneNumber: '+268760000009' });
    expect(v?.operatorType).toBe('transport');
    expect(v?.isVerified).toBe(true);
    expect(v?.verificationStatus).toBe('verified');
  });

  it('rejects a non-super-admin (403)', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${signVendorToken('000000000000000000000001')}`)
      .send({ businessName: 'X', email: 'x@x.co', password: 'secret1', operatorType: 'transport' });
    expect(res.status).toBe(403);
  });

  it('rejects a missing operatorType (400)', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/organizers')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ businessName: 'X', email: 'x@x.co', password: 'secret1' });
    expect(res.status).toBe(400);
  });
});
