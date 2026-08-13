// api/src/routes/__tests__/businessAuth.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { OtpService } from '@services/otp.service';

// Bypass real OTP: run the guarded action, no code check (mirrors A3's service test).
jest.spyOn(OtpService, 'withVerified').mockImplementation(async (_a, _i, _c, action: any) => action());

beforeAll(connectTestDb);
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
    serviceCategory: 'sound_hire',
    code: '000000',
  };

  it('creates a services business and signs it in (201)', async () => {
    const res = await request(app).post('/api/tickets/auth/business/register').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.operatorType).toBe('services');
  });

  it('400s when serviceCategory is missing', async () => {
    const { serviceCategory, ...rest } = validBody;
    const res = await request(app).post('/api/tickets/auth/business/register').send(rest);
    expect(res.status).toBe(400);
  });
});
