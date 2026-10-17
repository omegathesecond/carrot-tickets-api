import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
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
    serviceCategories: ['furniture_decor'],
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

  it('counts the full visible portfolio, excluding removed, processing and other authors', async () => {
    const vendor = await seedServicesVendor();
    const other = await seedServicesVendor();
    const post = (authorId: typeof vendor._id, status: string, mediaStatus: string) => ({
      authorType: 'vendor', authorId, kind: 'image', status,
      media: [{ rawKey: 'portfolio.jpg', status: mediaStatus, image: { url: 'https://cdn.test/portfolio.jpg', width: 1, height: 1 } }],
    });
    await Update.insertMany([
      ...Array.from({ length: 27 }, () => post(vendor._id, 'active', 'ready')),
      post(vendor._id, 'removed', 'ready'),
      post(vendor._id, 'active', 'processing'),
      post(other._id, 'active', 'ready'),
    ]);
    const res = await request(app).get(`/api/public/services/${vendor._id}`).expect(200);
    expect(res.body.data.portfolioCount).toBe(27);
    expect(res.body.data.rating.count).toBe(0);
    expect(res.body.data.followerCount).toBe(0);
    expect(res.body.data.followingCount).toBe(0);
  });

  it('404s for a random hex id (proves HttpError.statusCode maps correctly, not undefined -> 500)', async () => {
    await request(app).get('/api/public/services/0123456789abcdef01234567').expect(404);
  });
});
