import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { Vendor } from '@models/vendor.model';
import { BuyerOtp } from '@models/buyerOtp.model';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

jest.mock('@services/email.service');
jest.mock('@services/sms.service');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

beforeEach(() => {
  (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
  (SmsService.sendOtp as jest.Mock).mockResolvedValue(true);
});

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

const lastEmailCode = () =>
  (EmailService.sendOtp as jest.Mock).mock.calls.at(-1)?.[1] as string;
const lastSmsCode = () =>
  (SmsService.sendOtp as jest.Mock).mock.calls.at(-1)?.[1] as string;

describe('TicketsAuthService organizer signup OTP', () => {
  it('emails a code, then creates the organizer and signs them straight in', async () => {
    const req = await TicketsAuthService.requestRegistrationOtp({ email: 'org@x.com' });
    expect(req).toEqual({ channel: 'email', identifier: 'org@x.com' });
    expect(EmailService.sendOtp).toHaveBeenCalledTimes(1);
    expect(SmsService.sendOtp).not.toHaveBeenCalled();

    // No account exists until the code is verified.
    expect(await Vendor.findOne({ email: 'org@x.com' })).toBeNull();

    const result = await TicketsAuthService.register({
      businessName: 'Neogen',
      email: 'org@x.com',
      password: 'newpass1',
      code: lastEmailCode(),
    });
    const decoded = jwt.verify(result.accessToken, JWT_SECRET) as any;
    expect(decoded.vendorId).toBeTruthy();
    expect(decoded.userType).toBe('vendor');
    expect(decoded.app).toBe('tickets');
    expect(result.user.businessName).toBe('Neogen');
    expect(result.refreshToken).toBeTruthy();

    // Account now exists and can sign in.
    await expect(TicketsAuthService.login('org@x.com', 'newpass1')).resolves.toMatchObject({
      user: { businessName: 'Neogen' },
    });

    // Code is consumed.
    expect((await BuyerOtp.findOne({ audience: 'vendor', destination: 'org@x.com' }))!.consumed).toBe(true);
  });

  it('texts a code over SMS and stores the phone in E.164', async () => {
    // Organizer typed the local-trunk form; it must normalise to +268… so the
    // request-otp and register calls key the OTP on the same destination.
    const req = await TicketsAuthService.requestRegistrationOtp({ phoneNumber: '076385467' });
    expect(req.channel).toBe('sms');
    expect(req.identifier).toBe('+26876385467');
    expect(SmsService.sendOtp).toHaveBeenCalledWith('+26876385467', expect.stringMatching(/^\d{6}$/));

    await TicketsAuthService.register({
      businessName: 'Phone Org',
      phoneNumber: '076385467',
      password: 'newpass1',
      code: lastSmsCode(),
    });

    await expect(TicketsAuthService.login('076385467', 'newpass1')).resolves.toMatchObject({
      user: { businessName: 'Phone Org' },
    });
  });

  it('rejects requesting a code for an identifier that already has an organizer', async () => {
    await Vendor.create({ businessName: 'Taken', email: 'taken@x.com', password: 'existing1' });
    await expect(TicketsAuthService.requestRegistrationOtp({ email: 'taken@x.com' }))
      .rejects.toThrow(/already exists/i);
    expect(EmailService.sendOtp).not.toHaveBeenCalled();
  });

  it('rejects a wrong code, burns an attempt, and creates no account', async () => {
    await TicketsAuthService.requestRegistrationOtp({ email: 'org@x.com' });

    await expect(TicketsAuthService.register({
      businessName: 'Neogen',
      email: 'org@x.com',
      password: 'newpass1',
      code: '000000',
    })).rejects.toThrow(/incorrect/i);

    expect(await Vendor.findOne({ email: 'org@x.com' })).toBeNull();
    const otp = await BuyerOtp.findOne({ audience: 'vendor', destination: 'org@x.com' });
    expect(otp!.attempts).toBe(1);
    expect(otp!.consumed).toBe(false);
  });

  it('enforces the resend cooldown on the vendor signup path', async () => {
    await TicketsAuthService.requestRegistrationOtp({ email: 'org@x.com' });
    await expect(TicketsAuthService.requestRegistrationOtp({ email: 'org@x.com' }))
      .rejects.toThrow(/wait \d+ seconds? before requesting another code/i);
    expect(EmailService.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('rejects a password shorter than 6 characters before touching the code', async () => {
    await TicketsAuthService.requestRegistrationOtp({ email: 'org@x.com' });
    await expect(TicketsAuthService.register({
      businessName: 'Neogen',
      email: 'org@x.com',
      password: 'short',
      code: lastEmailCode(),
    })).rejects.toThrow(/at least 6/i);
    expect(await Vendor.findOne({ email: 'org@x.com' })).toBeNull();
  });

  it('requires an email or a phone number', async () => {
    await expect(TicketsAuthService.requestRegistrationOtp({}))
      .rejects.toThrow(/email address or phone number is required/i);
  });

  // A buyer and an organizer can share the same email; their signup codes must
  // never cross-authorise. Independent audiences also mean independent cooldowns
  // (both requests to the same address succeed).
  it('isolates buyer and vendor signup codes for the same email', async () => {
    await TicketsAuthService.requestRegistrationOtp({ email: 'dual@x.com' }); // audience: vendor
    const vendorCode = lastEmailCode();
    await BuyerAuthService.requestRegistrationOtp('dual@x.com');              // audience: buyer
    const buyerCode = lastEmailCode();

    // A buyer's code cannot create the organizer account...
    await expect(TicketsAuthService.register({
      businessName: 'Dual', email: 'dual@x.com', password: 'newpass1', code: buyerCode,
    })).rejects.toThrow(/incorrect/i);
    expect(await Vendor.findOne({ email: 'dual@x.com' })).toBeNull();

    // ...but the vendor's own code does.
    await expect(TicketsAuthService.register({
      businessName: 'Dual', email: 'dual@x.com', password: 'newpass1', code: vendorCode,
    })).resolves.toBeTruthy();
  });
});
