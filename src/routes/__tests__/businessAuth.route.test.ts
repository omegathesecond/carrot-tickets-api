// api/src/routes/__tests__/businessAuth.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import { MarketOpportunity } from '../../marketplace/models';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { OtpService } from '@services/otp.service';
import { ServiceCategory } from '@models/serviceCategory.model';

// Bypass real OTP: run the guarded action, no code check (mirrors A3's service test).
jest.spyOn(OtpService, 'withVerified').mockImplementation(async (_a, _i, _c, action: any) => action());

beforeAll(connectLedgerTestDb);
// serviceCategories is DB-driven (ServiceCategoryService.isValidActive) — seed
// the one category this suite uses before every test.
beforeEach(async () => {
  await ServiceCategory.create({ value: 'sound_hire', label: 'Sound hire', order: 0, isActive: true });
});
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});
afterAll(disconnectTestDb);

describe('POST /api/tickets/auth/business/register', () => {
  const validBody = {
    businessName: 'SoundWave Pro',
    phoneNumber: '+26876111222',
    password: 'secret1',
    serviceCategories: ['sound_hire'],
    code: '000000',
  };

  it('creates a services business and signs it in (201)', async () => {
    const res = await request(app).post('/api/tickets/auth/business/register').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.operatorType).toBe('services');
  });

  it('uses both signup selections to match Marketplace opportunities with the issued session', async () => {
    await ServiceCategory.create({ value: 'catering', label: 'Catering', isActive: true });
    const signup = await request(app).post('/api/tickets/auth/business/register').send({
      ...validBody, phoneNumber: '+26878422613', serviceCategories: ['sound_hire', 'catering'],
    });
    expect(signup.status).toBe(201);
    const opportunities = await MarketOpportunity.create(
      ['Sound hire', 'Catering', 'Photography'].map((category) => ({
        organiserId: new mongoose.Types.ObjectId(), name: category + ' opportunity',
        categories: [category], dates: ['2099-11-18'], applicationDeadline: new Date('2099-11-10'),
        status: 'published', scope: 'regular', capacity: 5,
      })),
    );
    const matches = await request(app).get('/api/marketplace/matched-opportunities')
      .set('Authorization', 'Bearer ' + signup.body.data.accessToken);
    expect(matches.status).toBe(200);
    expect(matches.body.data.items.map((item: any) => item._id).sort())
      .toEqual(opportunities.slice(0, 2).map((item) => String(item._id)).sort());
  });

  it.each([[], ['sound_hire', 'sound_hire'], ['sound_hire', 'unknown'], 'sound_hire'])(
    'rejects invalid category selections: %j', async (serviceCategories) => {
      const res = await request(app).post('/api/tickets/auth/business/register').send({ ...validBody, serviceCategories });
      expect(res.status).toBe(400);
    },
  );

  it('400s when serviceCategories is missing', async () => {
    const { serviceCategories, ...rest } = validBody;
    const res = await request(app).post('/api/tickets/auth/business/register').send(rest);
    expect(res.status).toBe(400);
  });
});
