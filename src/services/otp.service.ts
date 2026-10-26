import crypto from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import { SecurityRateLimitService, SecurityRateLimitError } from '@services/securityRateLimit.service';
import { BuyerOtp, OtpAudience } from '@models/buyerOtp.model';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Identifier } from '@utils/identifier.util';
import { OtpCooldownError } from '@utils/httpError.util';

/**
 * Shared one-time-passcode engine.
 *
 * Owns the whole code lifecycle — anti-spam cooldown, invalidate-previous,
 * 6-digit generation, SHA-256 hashing, TTL, attempt cap, timing-safe compare,
 * and channel-aware delivery — so the buyer (public site) and vendor
 * (organizer dashboard) flows can NEVER drift apart.
 *
 * Every operation is scoped by `audience`, because codes are keyed on the raw
 * destination and one person can be a buyer AND an organizer on the same
 * phone/email. Scoping keeps a buyer code from verifying a vendor reset (and
 * vice-versa) and stops one flow invalidating the other's live code. For a
 * user who only exists in one audience this is a no-op — no rows in the other
 * audience means the extra filter matches exactly what an unscoped query would.
 */
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
// Minimum gap between OTP requests to the SAME destination (per audience).
// Blocks someone hammering request-otp / forgot-password to spam a phone or
// email inbox (and burn SMS/email gateway credits). 60s matches a typical
// "resend code" cadence.
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;


export class OtpService {
  private static sendFor(id: Identifier, code: string): Promise<boolean> {
    return id.channel === 'email'
      ? EmailService.sendOtp(id.value, code)
      : SmsService.sendOtp(id.value, code);
  }

  /**
   * Enforce the resend cooldown, invalidate any outstanding codes for this
   * (audience, destination), then create + send a fresh 6-digit code.
   *
   * Throws a user-facing Error if the caller is inside the cooldown window, or
   * if the send gateway rejects the send (`sendFailMsg` — no silent fallback).
   */
  static async issue(audience: OtpAudience, id: Identifier, sendFailMsg: string): Promise<void> {
    try {
      await SecurityRateLimitService.consume(`otp:${audience}`, id.value, 1, OTP_RESEND_COOLDOWN_MS);
    } catch (error) {
      if (error instanceof SecurityRateLimitError) throw new OtpCooldownError(error.retryAfterSeconds);
      throw error;
    }

    // Invalidate any outstanding codes for this identifier so only the newest works.
    await BuyerOtp.updateMany({ audience, destination: id.value, consumed: false }, { consumed: true });

    const code = crypto.randomInt(100000, 1000000).toString(); // 6 digits
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await BuyerOtp.create({
      audience,
      channel: id.channel,
      destination: id.value,
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      consumed: false
    });

    const sent = await this.sendFor(id, code);
    if (!sent) {
      throw new Error(sendFailMsg);
    }
  }

  /** Atomically reserve a guess, then claim the code and account mutation in
   * one transaction. Only one concurrent valid proof can commit. */
  static async withVerified<T>(
    audience: OtpAudience,
    id: Identifier,
    code: string,
    action: (session: ClientSession) => Promise<T>
  ): Promise<T> {
    if (!code || !/^\d{6}$/.test(code)) {
      throw new Error('Enter the 6-digit code we sent you');
    }

    const otp = await BuyerOtp.findOne({
      audience,
      channel: id.channel,
      destination: id.value,
      consumed: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!otp) {
      throw new Error('That code has expired. Request a new one.');
    }

    // Reserve a guess atomically before comparing: parallel requests cannot
    // all read the same attempt count and overwrite one another's increment.
    const reserved = await BuyerOtp.findOneAndUpdate({
      _id: otp._id, consumed: false, expiresAt: { $gt: new Date() },
      attempts: { $lt: MAX_ATTEMPTS },
    }, { $inc: { attempts: 1 } }, { new: true });
    if (!reserved) throw new Error('Too many attempts or code already used. Request a new code.');

    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    // Constant-time compare to avoid leaking match progress via timing.
    const matches = reserved.codeHash.length === codeHash.length &&
      crypto.timingSafeEqual(Buffer.from(reserved.codeHash), Buffer.from(codeHash));

    if (!matches) throw new Error('That code is incorrect. Please try again.');

    // Claim and account mutation commit together. A failed save rolls back
    // the claim; simultaneous valid requests cannot both run the action.
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        const claimed = await BuyerOtp.findOneAndUpdate({
          _id: reserved._id, consumed: false, expiresAt: { $gt: new Date() }, codeHash,
        }, { $set: { consumed: true } }, { new: true, session });
        if (!claimed) throw new Error('That code has expired or was already used. Request a new one.');
        result = await action(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}
