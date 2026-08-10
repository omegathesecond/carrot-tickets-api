import crypto from 'crypto';
import { BuyerOtp, OtpAudience } from '@models/buyerOtp.model';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Identifier } from '@utils/identifier.util';

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
    // Cooldown gate: reject if a code was sent to this destination very
    // recently. Keyed on (audience, destination) and the newest row regardless
    // of consumed state, so an attacker requesting codes without ever consuming
    // them is still throttled.
    const recent = await BuyerOtp.findOne({ audience, destination: id.value }).sort({ createdAt: -1 });
    if (recent) {
      const elapsedMs = Date.now() - recent.createdAt.getTime();
      if (elapsedMs < OTP_RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        throw new Error(`Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`);
      }
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

  /**
   * Verify the newest unconsumed code for (audience, identifier), run the
   * caller's side-effect (`action`), and only THEN mark the code consumed.
   * Throws a user-facing Error on any verification failure (expired, too many
   * attempts, mismatch); wrong guesses still burn an attempt.
   *
   * The action runs AFTER verification but BEFORE the code is consumed on
   * purpose: if the action throws (a duplicate-key race, a failed password
   * save), the code is left valid so the caller can retry the SAME code —
   * instead of being stranded on a bogus "that code has expired". No token is
   * minted here — the caller decides what proving ownership grants.
   */
  static async withVerified<T>(
    audience: OtpAudience,
    id: Identifier,
    code: string,
    action: () => Promise<T>
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

    const result = await action();

    otp.consumed = true;
    await otp.save();
    return result;
  }
}
