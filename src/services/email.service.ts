/**
 * Email service for Carrot Tickets buyer auth.
 *
 * Buyers who register/sign in with an email prove ownership via a 6-digit OTP,
 * mirroring the SMS OTP flow. Delivery is via the "Carrot Tickets" YeboLink
 * workspace (same key as SMS). Like SmsService.sendOtp, this is NOT
 * fire-and-forget: the caller surfaces a false result to the buyer (no silent
 * fallback — they cannot sign in without the code).
 */
import { YeboLinkClient } from './yebolink.client';

const FROM_NAME = 'Carrot Tickets';

export class EmailService {
  static async sendOtp(email: string, code: string): Promise<boolean> {
    if (!email || !code) return false;
    const subject = `${code} is your Carrot Tickets code`;
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#1a1a1a">` +
      `<p>Your Carrot Tickets verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p>It expires in 10 minutes. Don't share it with anyone.</p>` +
      `</div>`;
    try {
      await YeboLinkClient.sendEmail(email, subject, html, FROM_NAME);
      console.log(`[Email] OTP dispatched to ${email} via YeboLink`);
      return true;
    } catch (error) {
      console.error('[Email] OTP send failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}
