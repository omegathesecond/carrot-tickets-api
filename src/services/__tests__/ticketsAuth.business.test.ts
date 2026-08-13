import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { OtpService } from '@services/otp.service';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

// Bypass real OTP: run the guarded action, no code check.
jest.spyOn(OtpService, 'withVerified').mockImplementation(async (_a, _i, _c, action: any) => action());

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('TicketsAuthService.registerBusiness', () => {
  it('creates a PENDING services vendor and mints a token with no ticket perms', async () => {
    const res = await TicketsAuthService.registerBusiness({
      businessName: 'SoundWave Pro', phoneNumber: '+26876111222', password: 'secret1',
      serviceCategory: 'sound_hire', startingPrice: { amountCents: 25000, unit: 'day' }, code: '000000',
    });
    const v = await Vendor.findOne({ phoneNumber: '+26876111222' });
    expect(v?.operatorType).toBe(OperatorType.SERVICES);
    expect(v?.serviceCategory).toBe('sound_hire');
    expect(v?.verificationStatus).toBe('pending');
    const claims: any = jwt.verify(res.accessToken, JWT_SECRET);
    expect(claims.permissions).toContain(TicketsPermission.MANAGE_ENQUIRIES);
    expect(claims.permissions).not.toContain(TicketsPermission.SELL_TICKETS);
    expect(res.refreshToken).toBeTruthy();
  });
});
