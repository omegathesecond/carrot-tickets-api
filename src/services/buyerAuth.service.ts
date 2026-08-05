import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { BuyerOtp } from '@models/buyerOtp.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { classifyIdentifier, Identifier } from '@utils/identifier.util';
import { JWT_SECRET } from '@config/jwt.config';

/**
 * Buyer (ticket-holder) authentication.
 *
 * Buyers authenticate with EITHER a phone number OR an email address — the
 * raw identifier is classified once via classifyIdentifier and every flow
 * below is generic over the resulting { channel, value } pair. Identity is
 * the buyer's Mongo _id (buyerId); phone/email are verified handles carried
 * on the token only when present, never the primary key.
 *
 * Two-tier flow that proves handle ownership exactly once:
 *
 *   - First-time registration is OTP-gated. An identifier with no account
 *     cannot be turned into an account by simply choosing a password — the
 *     caller must prove control of it with a one-time code first
 *     (requestRegistrationOtp -> registerWithOtp). This closes the
 *     account-takeover hole where anyone could "claim" a stranger's phone or
 *     email. SMS codes go via SmsService, email codes via EmailService
 *     (YeboLink under the hood for both).
 *   - Returning buyers sign in with identifier + password only (login). No
 *     OTP, so the per-message cost is paid at most once per buyer lifetime.
 *
 * Every issued token carries { app: 'tickets', userType: 'buyer', buyerId,
 * userPhone?, userEmail? }. buyerId rides the SAME secret and app claim
 * TicketsAuthService.verifyToken already accepts; userPhone/userEmail are
 * included only when the buyer has that verified handle, for callers that
 * still key off phone (e.g. "My Tickets" / purchase lookups).
 */
const BUYER_JWT_EXPIRY: string = process.env['BUYER_JWT_EXPIRY'] || '30d';
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 6;

export type BuyerIdentity = { phone?: string; email?: string };

export type LoginResult =
  | { requiresRegistration: true; channel: 'sms' | 'email'; identifier: string }
  | { requiresRegistration: false; accessToken: string; identity: BuyerIdentity };

export class BuyerAuthService {
  /**
   * Sign a buyer access token. Identity is buyerId; userPhone/userEmail ride
   * along only when the buyer has that verified handle.
   */
  static signToken(buyer: IBuyer): string {
    const payload: Record<string, unknown> = {
      userType: 'buyer',
      app: 'tickets',
      buyerId: String(buyer._id),
    };
    if (buyer.phone) payload['userPhone'] = buyer.phone;
    if (buyer.email) payload['userEmail'] = buyer.email;
    return jwt.sign(payload, JWT_SECRET, { expiresIn: BUYER_JWT_EXPIRY } as SignOptions);
  }

  private static identityOf(buyer: IBuyer): BuyerIdentity {
    return {
      ...(buyer.phone ? { phone: buyer.phone } : {}),
      ...(buyer.email ? { email: buyer.email } : {}),
    };
  }

  private static findByIdentifier(id: Identifier) {
    return id.channel === 'email'
      ? Buyer.findOne({ email: id.value })
      : Buyer.findOne({ phone: id.value });
  }

  private static async sendOtpFor(id: Identifier, code: string): Promise<boolean> {
    return id.channel === 'email'
      ? EmailService.sendOtp(id.value, code)
      : SmsService.sendOtp(id.value, code);
  }

  /**
   * Identifier (phone or email) + password login for EXISTING buyers.
   *
   * If the identifier has no account yet we do NOT create one here — instead
   * we report `requiresRegistration: true` so the caller can route the buyer
   * through OTP-gated registration. Returning buyers get their token straight
   * away with no OTP cost.
   */
  static async login(rawIdentifier: string, password: string): Promise<LoginResult> {
    const id = classifyIdentifier(rawIdentifier);
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const existing = await this.findByIdentifier(id).select('+password');
    if (!existing) {
      // No account on this identifier yet — ownership must be proven via OTP
      // before we create one. Don't leak password validity for non-accounts.
      return { requiresRegistration: true, channel: id.channel, identifier: id.value };
    }

    const matches = await existing.comparePassword(password);
    if (!matches) {
      throw new Error('Incorrect password. Please try again.');
    }

    existing.lastLoginAt = new Date();
    await existing.save();

    return { requiresRegistration: false, accessToken: this.signToken(existing), identity: this.identityOf(existing) };
  }

  /**
   * Step 1 of registration: generate + send a one-time code to an identifier
   * that does NOT yet have an account. Rejects identifiers that already have
   * an account (they must sign in with their password) — this both prevents
   * OTP spam to real users and stops the registration path from being used
   * as a password-less login bypass.
   *
   * Throws if the send gateway rejects the send (caller must surface the
   * failure — no silent fallback).
   */
  static async requestRegistrationOtp(rawIdentifier: string): Promise<{ channel: 'sms' | 'email'; identifier: string }> {
    const id = classifyIdentifier(rawIdentifier);

    const existing = await this.findByIdentifier(id);
    if (existing) {
      throw new Error('This account already exists. Please sign in with your password.');
    }

    // Invalidate any outstanding codes for this identifier so only the newest works.
    await BuyerOtp.updateMany({ destination: id.value, consumed: false }, { consumed: true });

    const code = crypto.randomInt(100000, 1000000).toString(); // 6 digits
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await BuyerOtp.create({
      channel: id.channel,
      destination: id.value,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      consumed: false
    });

    const sent = await this.sendOtpFor(id, code);
    if (!sent) {
      throw new Error('We could not send your verification code right now. Please try again.');
    }

    return { channel: id.channel, identifier: id.value };
  }

  /**
   * Step 2 of registration: verify the code, create the buyer account with
   * the chosen password and verified handle, and issue an access token. The
   * OTP proves the caller controls the identifier; the password secures all
   * subsequent sign-ins.
   */
  static async registerWithOtp(
    rawIdentifier: string,
    code: string,
    password: string,
    name?: string
  ): Promise<{ accessToken: string; identity: BuyerIdentity }> {
    const id = classifyIdentifier(rawIdentifier);
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    // Guard against a race / double-submit where the account was created
    // between requestRegistrationOtp and here.
    const existing = await this.findByIdentifier(id);
    if (existing) {
      throw new Error('This account already exists. Please sign in instead.');
    }

    await this.consumeOtp(id, code);

    const buyer = await Buyer.create({
      ...(id.channel === 'sms' ? { phone: id.value, phoneVerifiedAt: new Date() } : { email: id.value, emailVerifiedAt: new Date() }),
      password,
      ...(name ? { name } : {}),
      lastLoginAt: new Date(),
    });

    return { accessToken: this.signToken(buyer), identity: this.identityOf(buyer) };
  }

  /**
   * Step 1 of password reset: send a one-time code to an identifier that
   * DOES have an account. The mirror image of requestRegistrationOtp — that
   * one rejects existing accounts, this one requires one. Reuses the same
   * BuyerOtp plumbing.
   *
   * Throws if the identifier has no account (consistent with how login
   * already surfaces account existence via requiresRegistration) or if the
   * send gateway rejects the send (caller must surface the failure — no
   * silent fallback).
   */
  static async requestPasswordResetOtp(rawIdentifier: string): Promise<{ channel: 'sms' | 'email'; identifier: string }> {
    const id = classifyIdentifier(rawIdentifier);

    const existing = await this.findByIdentifier(id);
    if (!existing) {
      throw new Error("We couldn't find an account for this identifier. Please sign up instead.");
    }

    // Invalidate any outstanding codes for this identifier so only the newest works.
    await BuyerOtp.updateMany({ destination: id.value, consumed: false }, { consumed: true });

    const code = crypto.randomInt(100000, 1000000).toString(); // 6 digits
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await BuyerOtp.create({
      channel: id.channel,
      destination: id.value,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      consumed: false
    });

    const sent = await this.sendOtpFor(id, code);
    if (!sent) {
      throw new Error('We could not send your reset code right now. Please try again.');
    }

    return { channel: id.channel, identifier: id.value };
  }

  /**
   * Step 2 of password reset: verify the code, set the new password (the
   * model's pre-save hook re-hashes it), and issue a fresh access token so
   * the buyer is signed straight in. Proving identifier ownership via the
   * OTP is what authorises the password change.
   */
  static async resetPassword(
    rawIdentifier: string,
    code: string,
    newPassword: string
  ): Promise<{ accessToken: string; identity: BuyerIdentity }> {
    const id = classifyIdentifier(rawIdentifier);
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const buyer = await this.findByIdentifier(id).select('+password');
    if (!buyer) {
      throw new Error("We couldn't find an account for this identifier. Please sign up instead.");
    }

    await this.consumeOtp(id, code);

    buyer.password = newPassword;
    buyer.lastLoginAt = new Date();
    await buyer.save();

    return { accessToken: this.signToken(buyer), identity: this.identityOf(buyer) };
  }

  /**
   * Validate + consume the newest unconsumed OTP for an identifier. Throws a
   * user-facing Error on any failure (expired, too many attempts, mismatch)
   * and marks the code consumed on success. No token is minted here — the
   * caller decides what proving ownership grants.
   */
  private static async consumeOtp(id: Identifier, code: string): Promise<void> {
    if (!code || !/^\d{6}$/.test(code)) {
      throw new Error('Enter the 6-digit code we sent you');
    }

    const otp = await BuyerOtp.findOne({
      channel: id.channel,
      destination: id.value,
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
