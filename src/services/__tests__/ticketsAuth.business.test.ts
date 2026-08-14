import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { OtpService } from '@services/otp.service';
import { Vendor } from '@models/vendor.model';
import { ServiceCategory } from '@models/serviceCategory.model';
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

// registerBusiness now validates serviceCategory against the DB
// (ServiceCategoryService.isValidActive), not a hardcoded enum — seed the
// one category these tests need before every test.
beforeEach(async () => {
  await ServiceCategory.create({ value: 'sound_hire', label: 'Sound hire', order: 0, isActive: true });
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

  it('rejects an unknown/unseeded service category', async () => {
    await expect(TicketsAuthService.registerBusiness({
      businessName: 'Bad Cat Co', phoneNumber: '+26876111223', password: 'secret1',
      serviceCategory: 'bouncy_castle', code: '000000',
    })).rejects.toThrow('Choose a valid service category');
    expect(await Vendor.findOne({ phoneNumber: '+26876111223' })).toBeNull();
  });

  it('rejects a disabled service category', async () => {
    await ServiceCategory.updateOne({ value: 'sound_hire' }, { $set: { isActive: false } });
    await expect(TicketsAuthService.registerBusiness({
      businessName: 'Disabled Cat Co', phoneNumber: '+26876111224', password: 'secret1',
      serviceCategory: 'sound_hire', code: '000000',
    })).rejects.toThrow('Choose a valid service category');
  });
});
