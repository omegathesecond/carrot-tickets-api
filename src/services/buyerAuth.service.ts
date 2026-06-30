import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { BuyerOtp } from '@models/buyerOtp.model';
import { Buyer } from '@models/buyer.model';
import { SmsService } from '@services/sms.service';
import { normalizePhone, isValidPhone } from '@utils/phone.util';
import { JWT_SECRET } from '@config/secrets.config';

/**
 * Buyer (ticket-holder) authentication.
 *
 * Two-tier flow that proves phone ownership exactly once:
 *
 *   - First-time registration is OTP-gated. A phone with no account cannot be
 *     turned into an account by simply choosing a password — the caller must
 *     prove control of the number with a one-time SMS code first
 *     (requestRegistrationOtp -> registerWithOtp). This closes the
 *     account-takeover hole where anyone could "claim" a stranger's number.
 *   - Returning buyers sign in with phone + password only (login). No SMS,
 *     so the per-message cost is paid at most once per buyer lifetime.
 *
 * Every issued token carries { app: 'tickets', userType: 'buyer', userPhone }.
 * That rides the SAME secret and app claim TicketsAuthService.verifyToken
 * already accepts, so "My Tickets" / purchase (which key off userPhone) keep
 * working unchanged.
 */
const BUYER_JWT_EXPIRY: string = process.env['BUYER_JWT_EXPIRY'] || '30d';
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 6;

export type LoginResult =
  | { requiresRegistration: true; phone: string }
  | { requiresRegistration: false; accessToken: string; phone: string };

export class BuyerAuthService {
  /**
   * Sign a buyer access token for a (normalised) phone number.
   */
  private static signToken(phone: string): string {
    const payload = { userType: 'buyer', app: 'tickets', userPhone: phone };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: BUYER_JWT_EXPIRY } as SignOptions);
  }

  private static normalizeAndValidatePhone(rawPhone: string): string {
    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      throw new Error('Please enter a valid phone number');
    }
    return phone;
  }

  /**
   * Phone + password login for EXISTING buyers.
   *
   * If the phone has no account yet we do NOT create one here — instead we
   * report `requiresRegistration: true` so the caller can route the buyer
   * through OTP-gated registration. Returning buyers get their token straight
   * away with no SMS cost.
   */
  static async login(rawPhone: string, password: string): Promise<LoginResult> {
    const phone = this.normalizeAndValidatePhone(rawPhone);
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const existing = await Buyer.findOne({ phone }).select('+password');
    if (!existing) {
      // No account on this number yet — phone ownership must be proven via OTP
      // before we create one. Don't leak password validity for non-accounts.
      return { requiresRegistration: true, phone };
    }

    const matches = await existing.comparePassword(password);
    if (!matches) {
      throw new Error('Incorrect password. Please try again.');
    }

    existing.lastLoginAt = new Date();
    await existing.save();

    return { requiresRegistration: false, accessToken: this.signToken(phone), phone };
  }

  /**
   * Step 1 of registration: generate + SMS a one-time code to a phone that
   * does NOT yet have an account. Rejects numbers that already have an account
   * (they must sign in with their password) — this both prevents OTP spam to
   * real users and stops the registration path from being used as a
   * password-less login bypass.
   *
   * Throws if the SMS gateway rejects the send (caller must surface the
   * failure — no silent fallback).
   */
  static async requestRegistrationOtp(rawPhone: string): Promise<{ phone: string }> {
    const phone = this.normalizeAndValidatePhone(rawPhone);

    const existing = await Buyer.findOne({ phone });
    if (existing) {
      throw new Error('This number already has an account. Please sign in with your password.');
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
      throw new Error('We could not send your verification code right now. Please try again.');
    }

    return { phone };
  }

  /**
   * Step 2 of registration: verify the SMS code, create the buyer account with
   * the chosen password, and issue an access token. The OTP proves the caller
   * controls the phone; the password secures all subsequent sign-ins.
   */
  static async registerWithOtp(
    rawPhone: string,
    code: string,
    password: string,
    name?: string
  ): Promise<{ accessToken: string; phone: string }> {
    const phone = this.normalizeAndValidatePhone(rawPhone);
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    // Guard against a race / double-submit where the account was created
    // between requestRegistrationOtp and here.
    const existing = await Buyer.findOne({ phone });
    if (existing) {
      throw new Error('This number already has an account. Please sign in instead.');
    }

    await this.consumeOtp(phone, code);

    const buyer = await Buyer.create({
      phone,
      password,
      ...(name ? { name } : {}),
      lastLoginAt: new Date()
    });

    return { accessToken: this.signToken(buyer.phone), phone };
  }

  /**
   * Validate + consume the newest unconsumed OTP for a phone. Throws a
   * user-facing Error on any failure (expired, too many attempts, mismatch)
   * and marks the code consumed on success. No token is minted here — the
   * caller decides what proving phone ownership grants.
   */
  private static async consumeOtp(phone: string, code: string): Promise<void> {
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
  }
}
