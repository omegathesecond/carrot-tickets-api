import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { BuyerOtp } from '@models/buyerOtp.model';
import { Buyer } from '@models/buyer.model';
import { SmsService } from '@services/sms.service';
import { normalizePhone, isValidPhone } from '@utils/phone.util';

/**
 * Buyer (ticket-holder) authentication.
 *
 * Buyers authenticate with phone + password (see loginOrRegister) — no SMS
 * one-time codes, since per-message SMS cost made OTP login expensive. On
 * success we mint a JWT carrying { app: 'tickets', userType: 'buyer',
 * userPhone }. That token rides the SAME secret and the SAME app claim the
 * existing TicketsAuthService.verifyToken already accepts, so the buyer can
 * reuse the established /my-tickets lookup (which keys off userPhone) without
 * a parallel auth stack. The legacy OTP methods remain below but are no longer
 * wired into the public routes.
 */
const JWT_SECRET: string = process.env['JWT_SECRET'] || 'your-secret-key';
const BUYER_JWT_EXPIRY: string = process.env['BUYER_JWT_EXPIRY'] || '30d';
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

export class BuyerAuthService {
  /**
   * Sign a buyer access token for a (normalised) phone number.
   */
  private static signToken(phone: string): string {
    const payload = { userType: 'buyer', app: 'tickets', userPhone: phone };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: BUYER_JWT_EXPIRY } as SignOptions);
  }

  /**
   * Phone + password login with register-on-first-use.
   *
   * The first time a phone signs in we create the buyer account with the
   * supplied password; on every subsequent sign-in we verify the password.
   * This keeps the UX to a single phone+password form with no SMS cost while
   * still protecting returning buyers from someone guessing their number.
   */
  static async loginOrRegister(
    rawPhone: string,
    password: string,
    name?: string
  ): Promise<{ accessToken: string; phone: string; isNewAccount: boolean }> {
    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      throw new Error('Please enter a valid phone number');
    }
    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    const existing = await Buyer.findOne({ phone }).select('+password');

    if (!existing) {
      // First sign-in for this number — create the account.
      const buyer = await Buyer.create({
        phone,
        password,
        ...(name ? { name } : {}),
        lastLoginAt: new Date()
      });
      return { accessToken: this.signToken(buyer.phone), phone, isNewAccount: true };
    }

    const matches = await existing.comparePassword(password);
    if (!matches) {
      throw new Error('Incorrect password. Please try again.');
    }

    existing.lastLoginAt = new Date();
    await existing.save();

    return { accessToken: this.signToken(phone), phone, isNewAccount: false };
  }

  /**
   * Generate + SMS a login code for a phone number. Returns the normalised
   * phone so the caller can echo it back to the UI. Throws if the SMS
   * gateway rejects the send (buyer must know it failed).
   */
  static async requestOtp(rawPhone: string): Promise<{ phone: string }> {
    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      throw new Error('Please enter a valid phone number');
    }

    // Invalidate any outstanding codes for this number so only the newest works.
    await BuyerOtp.updateMany({ phone, consumed: false }, { consumed: true });

    const code = crypto.randomInt(100000, 1000000).toString(); // 6 digits
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await BuyerOtp.create({
      phone,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      consumed: false
    });

    const sent = await SmsService.sendOtp(phone, code);
    if (!sent) {
      throw new Error('We could not send your login code right now. Please try again.');
    }

    return { phone };
  }

  /**
   * Verify a code and, on success, issue a buyer access token.
   */
  static async verifyOtp(rawPhone: string, code: string): Promise<{ accessToken: string; phone: string }> {
    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      throw new Error('Please enter a valid phone number');
    }
    if (!code || !/^\d{6}$/.test(code)) {
      throw new Error('Enter the 6-digit code we sent you');
    }

    const otp = await BuyerOtp.findOne({
      phone,
      consumed: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!otp) {
      throw new Error('That code has expired. Request a new one.');
    }

    if (otp.attempts >= MAX_ATTEMPTS) {
      otp.consumed = true;
      await otp.save();
      throw new Error('Too many attempts. Request a new code.');
    }

    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    // Constant-time compare to avoid leaking match progress via timing.
    const matches = otp.codeHash.length === codeHash.length &&
      crypto.timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(codeHash));

    if (!matches) {
      otp.attempts += 1;
      await otp.save();
      throw new Error('That code is incorrect. Please try again.');
    }

    otp.consumed = true;
    await otp.save();

    const payload = {
      userType: 'buyer',
      app: 'tickets',
      userPhone: phone
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: BUYER_JWT_EXPIRY } as SignOptions);

    return { accessToken, phone };
  }
}
