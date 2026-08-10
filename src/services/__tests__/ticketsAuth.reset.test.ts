import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { BuyerOtp } from '@models/buyerOtp.model';
import { RefreshToken } from '@models/refreshToken.model';
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

describe('TicketsAuthService organizer password reset', () => {
  it('emails a code, resets, and signs the organizer straight in', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });

    const req = await TicketsAuthService.requestPasswordResetOtp('org@x.com');
    expect(req).toEqual({ channel: 'email', identifier: 'org@x.com' });
    expect(EmailService.sendOtp).toHaveBeenCalledTimes(1);
    expect(SmsService.sendOtp).not.toHaveBeenCalled();

    const otp = await BuyerOtp.findOne({ audience: 'vendor', destination: 'org@x.com' });
    expect(otp).toBeTruthy();

    const result = await TicketsAuthService.resetPassword('org@x.com', lastEmailCode(), 'newpass1');
    const decoded = jwt.verify(result.accessToken, JWT_SECRET) as any;
    expect(decoded.vendorId).toBeTruthy();
    expect(decoded.userType).toBe('vendor');
    expect(decoded.app).toBe('tickets');
    expect(result.user.businessName).toBe('Neogen');
    expect(result.refreshToken).toBeTruthy();

    // Old password no longer works; new one does.
    await expect(TicketsAuthService.login('org@x.com', 'oldpass1')).rejects.toThrow(/invalid credentials/i);
    await expect(TicketsAuthService.login('org@x.com', 'newpass1')).resolves.toMatchObject({
      user: { businessName: 'Neogen' },
    });

    // Code is consumed.
    expect((await BuyerOtp.findOne({ audience: 'vendor', destination: 'org@x.com' }))!.consumed).toBe(true);
  });

  it('texts a code over SMS and matches a phone stored in a different format', async () => {
    await Vendor.create({ businessName: 'Phone Org', phoneNumber: '+26876385467', password: 'oldpass1' });

    // Organizer typed the local-trunk form; must still resolve the +268 record.
    const req = await TicketsAuthService.requestPasswordResetOtp('076385467');
    expect(req.channel).toBe('sms');
    expect(SmsService.sendOtp).toHaveBeenCalledTimes(1);
    expect(SmsService.sendOtp).toHaveBeenCalledWith('+26876385467', expect.stringMatching(/^\d{6}$/));

    await TicketsAuthService.resetPassword('076385467', lastSmsCode(), 'newpass1');
    await expect(TicketsAuthService.login('+26876385467', 'newpass1')).resolves.toMatchObject({
      user: { businessName: 'Phone Org' },
    });
  });

  it('rejects an unknown identifier', async () => {
    await expect(TicketsAuthService.requestPasswordResetOtp('nobody@x.com')).rejects.toThrow(/couldn't find an organizer/i);
    expect(EmailService.sendOtp).not.toHaveBeenCalled();
  });

  it('rejects a wrong code (burns an attempt) and leaves the password unchanged', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await TicketsAuthService.requestPasswordResetOtp('org@x.com');

    await expect(TicketsAuthService.resetPassword('org@x.com', '000000', 'newpass1')).rejects.toThrow(/incorrect/i);

    const otp = await BuyerOtp.findOne({ audience: 'vendor', destination: 'org@x.com' });
    expect(otp!.attempts).toBe(1);
    expect(otp!.consumed).toBe(false);
    await expect(TicketsAuthService.login('org@x.com', 'oldpass1')).resolves.toBeTruthy();
  });

  it('enforces the resend cooldown on the vendor reset path', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await TicketsAuthService.requestPasswordResetOtp('org@x.com');
    await expect(TicketsAuthService.requestPasswordResetOtp('org@x.com'))
      .rejects.toThrow(/wait \d+ seconds? before requesting another code/i);
    expect(EmailService.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('refuses to reset an inactive organizer (no suspension bypass)', async () => {
    await Vendor.create({ businessName: 'Suspended', email: 'susp@x.com', password: 'oldpass1', isActive: false });
    await expect(TicketsAuthService.requestPasswordResetOtp('susp@x.com')).rejects.toThrow(/inactive/i);
    expect(EmailService.sendOtp).not.toHaveBeenCalled();
  });

  it('rejects a new password shorter than 6 characters', async () => {
    await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await TicketsAuthService.requestPasswordResetOtp('org@x.com');
    await expect(TicketsAuthService.resetPassword('org@x.com', lastEmailCode(), 'short')).rejects.toThrow(/at least 6/i);
  });

  it('revokes existing refresh tokens on reset', async () => {
    const vendor = await Vendor.create({ businessName: 'Neogen', email: 'org@x.com', password: 'oldpass1' });
    await RefreshToken.create({ token: 'stale-token', vendorId: vendor._id.toString(), userType: 'vendor', expiresAt: new Date(Date.now() + 3600_000), isRevoked: false });

    await TicketsAuthService.requestPasswordResetOtp('org@x.com');
    await TicketsAuthService.resetPassword('org@x.com', lastEmailCode(), 'newpass1');

    expect((await RefreshToken.findOne({ token: 'stale-token' }))!.isRevoked).toBe(true);
  });

  // The core isolation guarantee: a buyer and an organizer can share the same
  // email, and their codes must never cross-authorise. Independent audiences
  // also mean independent cooldowns (both requests to the same address succeed).
  it('isolates buyer and vendor codes for the same email', async () => {
    await Vendor.create({ businessName: 'Dual', email: 'dual@x.com', password: 'oldvendor1' });
    await Buyer.create({ email: 'dual@x.com', password: 'oldbuyer1', emailVerifiedAt: new Date() });

    await TicketsAuthService.requestPasswordResetOtp('dual@x.com'); // audience: vendor
    const vendorCode = lastEmailCode();
    await BuyerAuthService.requestPasswordResetOtp('dual@x.com');   // audience: buyer
    const buyerCode = lastEmailCode();

    // A buyer's code cannot reset the organizer...
    await expect(TicketsAuthService.resetPassword('dual@x.com', buyerCode, 'hacked1')).rejects.toThrow(/incorrect/i);
    // ...and a vendor's code cannot reset the buyer.
    await expect(BuyerAuthService.resetPassword('dual@x.com', vendorCode, 'hacked1')).rejects.toThrow(/incorrect/i);

    // Each code still works within its own audience.
    await expect(TicketsAuthService.resetPassword('dual@x.com', vendorCode, 'newvendor1')).resolves.toBeTruthy();
    await expect(BuyerAuthService.resetPassword('dual@x.com', buyerCode, 'newbuyer1')).resolves.toBeTruthy();
  });
});
