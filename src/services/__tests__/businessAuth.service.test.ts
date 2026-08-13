import jwt from 'jsonwebtoken';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { BusinessAuthService } from '@services/businessAuth.service';
import { Vendor } from '@models/vendor.model';
import { AccountKind } from '@interfaces/vendor.interface';
import { BuyerOtp } from '@models/buyerOtp.model';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { JWT_SECRET } from '@config/jwt.config';

jest.mock('@services/email.service');
jest.mock('@services/sms.service');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('BusinessAuthService', () => {
  it('sends an OTP and registers a BUSINESS vendor after verifying it', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);

    const { channel, identifier } = await BusinessAuthService.requestRegistrationOtp('caterer@x.com');
    expect(channel).toBe('email');
    expect(identifier).toBe('caterer@x.com');
    expect(EmailService.sendOtp).toHaveBeenCalled();

    const otp = await BuyerOtp.findOne({ channel: 'email', destination: 'caterer@x.com' });
    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];
    expect(otp).toBeTruthy();

    const { accessToken, refreshToken } = await BusinessAuthService.registerWithOtp(
      'caterer@x.com',
      code,
      'secret6',
      'Sipho Catering',
      'Catering'
    );
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    const decoded = jwt.verify(accessToken, JWT_SECRET) as any;
    expect(decoded.userType).toBe('vendor');
    expect(decoded.app).toBe('tickets');

    const vendor = await Vendor.findOne({ email: 'caterer@x.com' });
    expect(vendor).toBeTruthy();
    expect(vendor!.accountKind).toBe(AccountKind.BUSINESS);
    expect(vendor!.serviceCategory).toBe('Catering');
    expect(vendor!.businessName).toBe('Sipho Catering');
  });

  it('rejects an unverified code', async () => {
    (SmsService.sendOtp as jest.Mock).mockResolvedValue(true);
    await BusinessAuthService.requestRegistrationOtp('+26878422613');

    await expect(
      BusinessAuthService.registerWithOtp('+26878422613', '000000', 'secret6', 'Loud Sound Hire', 'Sound Hire')
    ).rejects.toThrow(/expired|incorrect/i);
  });

  it('rejects an identifier that already has a vendor account', async () => {
    await Vendor.create({ email: 'taken@x.com', password: 'secret6', businessName: 'Existing Co' });

    await expect(BusinessAuthService.requestRegistrationOtp('taken@x.com')).rejects.toThrow(/already exists/i);
  });

  it('rejects an invalid service category', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
    await BusinessAuthService.requestRegistrationOtp('bad-cat@x.com');
    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];

    await expect(
      BusinessAuthService.registerWithOtp('bad-cat@x.com', code, 'secret6', 'Some Biz', 'Not A Real Category')
    ).rejects.toThrow(/valid business category/i);
  });

  it('defaults plain organizer signup to accountKind ORGANIZER (unaffected by the business path)', async () => {
    const vendor = await Vendor.create({ email: 'organizer@x.com', password: 'secret6', businessName: 'Big Events Co' });
    expect(vendor.accountKind).toBe(AccountKind.ORGANIZER);
    expect(vendor.serviceCategory).toBeUndefined();
  });
});
