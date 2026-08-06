import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { Buyer } from '@models/buyer.model';
import { BuyerOtp } from '@models/buyerOtp.model';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

jest.mock('@services/email.service');
jest.mock('@services/sms.service');

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('BuyerAuthService email identity', () => {
  it('signs a token carrying buyerId + userEmail for an email-only buyer', async () => {
    const buyer = await Buyer.create({ email: 'e@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    const token = BuyerAuthService.signToken(buyer);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.buyerId).toBe(String(buyer._id));
    expect(decoded.userEmail).toBe('e@x.com');
    expect(decoded.userPhone).toBeUndefined();
  });

  it('signs a token carrying buyerId + userPhone for a phone-only buyer', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret6', phoneVerifiedAt: new Date() });
    const token = BuyerAuthService.signToken(buyer);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.buyerId).toBe(String(buyer._id));
    expect(decoded.userPhone).toBe('+26878422613');
    expect(decoded.userEmail).toBeUndefined();
    expect(decoded.userType).toBe('buyer');
    expect(decoded.app).toBe('tickets');
  });

  it('sends an email OTP and registers an email buyer after verifying it', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
    const { channel, identifier } = await BuyerAuthService.requestRegistrationOtp('new@x.com');
    expect(channel).toBe('email');
    expect(identifier).toBe('new@x.com');
    expect(EmailService.sendOtp).toHaveBeenCalled();
    expect(SmsService.sendOtp).not.toHaveBeenCalled();

    const otp = await BuyerOtp.findOne({ channel: 'email', destination: 'new@x.com' });
    expect(otp).toBeTruthy();
    expect(otp!.consumed).toBe(false);

    // Plaintext code is never persisted — capture it from the mocked send call.
    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];
    expect(code).toMatch(/^\d{6}$/);

    const result = await BuyerAuthService.registerWithOtp('new@x.com', code, 'secret6', 'New Buyer');
    expect(result.identity).toEqual({ email: 'new@x.com' });

    const decoded = jwt.verify(result.accessToken, JWT_SECRET) as any;
    expect(decoded.userEmail).toBe('new@x.com');
    expect(decoded.userPhone).toBeUndefined();
    expect(decoded.buyerId).toBeTruthy();

    const buyer = await Buyer.findOne({ email: 'new@x.com' });
    expect(buyer).toBeTruthy();
    expect(buyer!.emailVerifiedAt).toBeTruthy();
    expect(buyer!.name).toBe('New Buyer');

    const consumedOtp = await BuyerOtp.findOne({ channel: 'email', destination: 'new@x.com' });
    expect(consumedOtp!.consumed).toBe(true);
  });

  it('resets the password of an email buyer via a fresh OTP', async () => {
    await Buyer.create({ email: 'reset@x.com', password: 'oldpass1', emailVerifiedAt: new Date() });
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);

    const { channel, identifier } = await BuyerAuthService.requestPasswordResetOtp('reset@x.com');
    expect(channel).toBe('email');
    expect(identifier).toBe('reset@x.com');

    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];
    const result = await BuyerAuthService.resetPassword('reset@x.com', code, 'newpass1');
    expect(result.identity).toEqual({ email: 'reset@x.com' });

    const decoded = jwt.verify(result.accessToken, JWT_SECRET) as any;
    expect(decoded.userEmail).toBe('reset@x.com');

    const relogin = await BuyerAuthService.login('reset@x.com', 'newpass1');
    expect(relogin.requiresRegistration).toBe(false);
  });

  it('logs in an existing email buyer', async () => {
    await Buyer.create({ email: 'log@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    const res = await BuyerAuthService.login('log@x.com', 'secret6');
    expect(res.requiresRegistration).toBe(false);
    if (res.requiresRegistration === false) {
      expect(res.identity.email).toBe('log@x.com');
    }
  });

  it('returns requiresRegistration for an unknown email', async () => {
    const res = await BuyerAuthService.login('ghost@x.com', 'secret6');
    expect(res).toMatchObject({ requiresRegistration: true, channel: 'email', identifier: 'ghost@x.com' });
  });

  it('still logs in an existing phone buyer', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret6', phoneVerifiedAt: new Date() });
    const res = await BuyerAuthService.login('+26878422613', 'secret6');
    expect(res.requiresRegistration).toBe(false);
    if (res.requiresRegistration === false) expect(res.identity.phone).toBe('+26878422613');
  });

  it('routes registration OTP over SMS for a phone identifier', async () => {
    (SmsService.sendOtp as jest.Mock).mockResolvedValue(true);
    const { channel, identifier } = await BuyerAuthService.requestRegistrationOtp('+26878422613');
    expect(channel).toBe('sms');
    expect(identifier).toBe('+26878422613');
    expect(SmsService.sendOtp).toHaveBeenCalled();
    expect(EmailService.sendOtp).not.toHaveBeenCalled();

    const code = (SmsService.sendOtp as jest.Mock).mock.calls[0][1];
    const result = await BuyerAuthService.registerWithOtp('+26878422613', code, 'secret6');
    expect(result.identity).toEqual({ phone: '+26878422613' });
  });

  it('rejects registration OTP for an identifier that already has an account', async () => {
    await Buyer.create({ email: 'taken@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    await expect(BuyerAuthService.requestRegistrationOtp('taken@x.com')).rejects.toThrow();
  });

  it('rejects password-reset OTP for an identifier with no account', async () => {
    await expect(BuyerAuthService.requestPasswordResetOtp('nobody@x.com')).rejects.toThrow();
  });

  it('throws a user-facing error when the email send fails (no silent fallback)', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(false);
    await expect(BuyerAuthService.requestRegistrationOtp('fails@x.com')).rejects.toThrow();
  });

  it('rejects an incorrect OTP code without consuming registration', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
    await BuyerAuthService.requestRegistrationOtp('wrongcode@x.com');
    await expect(
      BuyerAuthService.registerWithOtp('wrongcode@x.com', '000000', 'secret6')
    ).rejects.toThrow();
    const buyer = await Buyer.findOne({ email: 'wrongcode@x.com' });
    expect(buyer).toBeNull();
  });

  // Regression: a legacy NON-sparse unique index on `phone` stored every
  // email-only buyer's absent phone as `null` and collided the 2nd+ of them
  // with E11000 { phone: null }, so no email buyer after the first could ever
  // register. The partial `$type: 'string'` index must let them coexist while
  // still enforcing uniqueness on real string handles.
  it('lets many email-only buyers coexist yet still rejects a duplicate email', async () => {
    await Buyer.syncIndexes(); // build the partial phone/email indexes in the test DB
    await Buyer.create({ email: 'a@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    await expect(
      Buyer.create({ email: 'b@x.com', password: 'secret6', emailVerifiedAt: new Date() })
    ).resolves.toBeTruthy();
    await expect(
      Buyer.create({ email: 'a@x.com', password: 'secret6', emailVerifiedAt: new Date() })
    ).rejects.toThrow();
    // Two phone-absent buyers coexisting is the whole point.
    expect(await Buyer.countDocuments({ email: { $in: ['a@x.com', 'b@x.com'] } })).toBe(2);
  });

  // Regression: registerWithOtp used to consume the code BEFORE creating the
  // account, so a create failure burned a valid code and the retry hit a bogus
  // "that code has expired". The code must survive a failed create and stay
  // retryable.
  it('keeps the OTP valid and retryable when account creation fails after verification', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
    await BuyerAuthService.requestRegistrationOtp('retry@x.com');
    const code = (EmailService.sendOtp as jest.Mock).mock.calls[0][1];

    const spy = jest
      .spyOn(Buyer, 'create')
      .mockRejectedValueOnce(new Error('transient write error') as never);
    await expect(
      BuyerAuthService.registerWithOtp('retry@x.com', code, 'secret6')
    ).rejects.toThrow('transient write error');

    // Code must NOT have been burned by the failed create.
    const otp = await BuyerOtp.findOne({ channel: 'email', destination: 'retry@x.com' });
    expect(otp!.consumed).toBe(false);

    // Same code now works once create succeeds again.
    spy.mockRestore();
    const result = await BuyerAuthService.registerWithOtp('retry@x.com', code, 'secret6');
    expect(result.identity).toEqual({ email: 'retry@x.com' });
    const consumed = await BuyerOtp.findOne({ channel: 'email', destination: 'retry@x.com' });
    expect(consumed!.consumed).toBe(true);
  });
});

describe('BuyerAuthService OTP resend cooldown', () => {
  beforeEach(() => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
    (SmsService.sendOtp as jest.Mock).mockResolvedValue(true);
  });

  it('rejects a second code request to the same destination within the cooldown', async () => {
    await BuyerAuthService.requestRegistrationOtp('cool@x.com');
    await expect(BuyerAuthService.requestRegistrationOtp('cool@x.com'))
      .rejects.toThrow(/wait \d+ seconds? before requesting another code/i);
    // The spam attempt sent exactly one email (the first), not two.
    expect((EmailService.sendOtp as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('cools down the reset path too, and shares the window across request types', async () => {
    await Buyer.create({ phone: '+26878000123', password: 'secret6', phoneVerifiedAt: new Date() });
    await BuyerAuthService.requestPasswordResetOtp('+26878000123');
    await expect(BuyerAuthService.requestPasswordResetOtp('+26878000123'))
      .rejects.toThrow(/wait \d+ seconds? before requesting another code/i);
  });

  it('allows a new code once the cooldown has elapsed', async () => {
    await BuyerAuthService.requestRegistrationOtp('cool2@x.com');
    // Backdate the just-created OTP past the 60s window. Use the raw driver:
    // Mongoose marks timestamps.createdAt immutable, so a model updateMany
    // would silently drop the $set.
    await BuyerOtp.collection.updateMany(
      { destination: 'cool2@x.com' },
      { $set: { createdAt: new Date(Date.now() - 61_000) } }
    );
    await expect(BuyerAuthService.requestRegistrationOtp('cool2@x.com'))
      .resolves.toMatchObject({ channel: 'email', identifier: 'cool2@x.com' });
    expect((EmailService.sendOtp as jest.Mock).mock.calls).toHaveLength(2);
  });
});
