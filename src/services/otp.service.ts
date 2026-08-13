import crypto from 'crypto';
import { BuyerOtp } from '@models/buyerOtp.model';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Identifier } from '@utils/identifier.util';

/**
 * One-time-code issuance/verification, shared by every OTP-gated flow that
 * proves control of a phone number or email address before an account gets
 * created or changed — buyer registration/reset (@services/buyerAuth.service)
 * and business registration (@services/businessAuth.service). Everything here
 * is keyed on destination+channel via the same BuyerOtp store, independent of
 * which account type eventually gets created — the name predates the
 * business flow but the store has always been identifier-shaped, not
 * buyer-shaped.
 */
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
// Minimum gap between OTP requests to the SAME destination. Blocks someone
// hammering request-otp / forgot-password to spam a phone or email inbox (and
// burn SMS/email gateway credits). 60s matches a typical "resend code" cadence.
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export class OtpService {
  private static async sendOtpFor(id: Identifier, code: string): Promise<boolean> {
    return id.channel === 'email'
      ? EmailService.sendOtp(id.value, code)
      : SmsService.sendOtp(id.value, code);
  }

  /**
   * Issue a fresh OTP for an identifier: enforce the resend cooldown, invalidate
   * any outstanding codes, then create + send the new one.
   *
   * Throws a user-facing Error if the caller is inside the cooldown window, or
   * if the send gateway rejects the send (`sendFailMsg` — no silent fallback).
   */
  static async issueOtp(id: Identifier, sendFailMsg: string): Promise<void> {
    // Cooldown gate: reject if a code was sent to this destination very
    // recently. Keyed on destination and the newest row regardless of consumed
    // state, so an attacker requesting codes without ever consuming them is
    // still throttled.
    const recent = await BuyerOtp.findOne({ destination: id.value }).sort({ createdAt: -1 });
    if (recent) {
      const elapsedMs = Date.now() - recent.createdAt.getTime();
      if (elapsedMs < OTP_RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        throw new Error(`Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`);
      }
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
      throw new Error(sendFailMsg);
    }
  }

  /**
   * Validate + consume the newest unconsumed OTP for an identifier. Throws a
   * user-facing Error on any failure (expired, too many attempts, mismatch)
   * and marks the code consumed on success. No token is minted here — the
   * caller decides what proving ownership grants.
   */
  static async consumeOtp(id: Identifier, code: string): Promise<void> {
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
