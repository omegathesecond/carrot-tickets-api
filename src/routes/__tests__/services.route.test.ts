import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedServicesVendor() {
  return Vendor.create({
    businessName: 'Luxe Decor',
    phoneNumber: '+26876500' + Math.floor(Math.random() * 10000),
    password: 'secret1',
    operatorType: OperatorType.SERVICES,
    serviceCategory: 'furniture_decor',
    verificationStatus: VerificationStatus.VERIFIED,
    bio: 'Elegant furniture & styling',
  });
}

describe('GET /api/public/services', () => {
  it('200s with the verified services vendor as a card in data.items', async () => {
    const vendor = await seedServicesVendor();
    const res = await request(app).get('/api/public/services').expect(200);
    const ids = res.body.data.items.map((c: any) => c.id);
    expect(ids).toContain(String(vendor._id));
  });
});

describe('GET /api/public/services/:businessId', () => {
  it('200s with the business profile for a verified services vendor', async () => {
    const vendor = await seedServicesVendor();
    const res = await request(app).get(`/api/public/services/${vendor._id}`).expect(200);
    expect(res.body.data.businessName).toBe('Luxe Decor');
    expect(res.body.data.verified).toBe(true);
  });

  it('404s for a random hex id (proves HttpError.statusCode maps correctly, not undefined -> 500)', async () => {
    await request(app).get('/api/public/services/0123456789abcdef01234567').expect(404);
  });
});
