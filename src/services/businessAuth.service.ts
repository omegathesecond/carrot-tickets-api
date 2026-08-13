import { Vendor } from '@models/vendor.model';
import { AccountKind } from '@interfaces/vendor.interface';
import { BUSINESS_CATEGORIES, BusinessCategory } from '@/constants/businessCategories';
import { classifyIdentifier, Identifier } from '@utils/identifier.util';
import { OtpService } from '@services/otp.service';
import { TicketsAuthService } from '@services/ticketsAuth.service';

/**
 * Self-service signup for BUSINESS-kind vendors (event-services suppliers —
 * Sound Hire, Catering, Decor, ...) from the public site's buyer-facing
 * "Tickets" screen, alongside ordinary buyer signup. A business account IS a
 * Vendor (same auth/social/profile plumbing as an event organizer), just
 * created through a phone/email-OTP-gated flow instead of the dashboard
 * app's plain form — this consumer surface treats identifier ownership the
 * same way it does for buyers (@services/buyerAuth.service), which the
 * dashboard's organizer signup does not.
 *
 * Two-step flow, identical shape to buyer registration:
 *   requestRegistrationOtp -> registerWithOtp.
 */
const MIN_PASSWORD_LENGTH = 6;
const MAX_BUSINESS_NAME_LENGTH = 100;

export class BusinessAuthService {
  private static findByIdentifier(id: Identifier) {
    return id.channel === 'email'
      ? Vendor.findOne({ email: id.value })
      : Vendor.findOne({ phoneNumber: id.value });
  }

  /**
   * Step 1: send a verification code to an identifier with no VENDOR account
   * yet. Rejects identifiers that already have one (organizer or business —
   * they must sign in with their password instead, at /brand/login).
   */
  static async requestRegistrationOtp(rawIdentifier: string): Promise<{ channel: 'sms' | 'email'; identifier: string }> {
    const id = classifyIdentifier(rawIdentifier);

    const existing = await this.findByIdentifier(id);
    if (existing) {
      throw new Error('This account already exists. Please sign in with your password.');
    }

    await OtpService.issueOtp(id, 'We could not send your verification code right now. Please try again.');
    return { channel: id.channel, identifier: id.value };
  }

  /**
   * Step 2: verify the code, create the BUSINESS vendor account and issue
   * tokens the same way organizer signup does (TicketsAuthService.register),
   * so a business account is a first-class vendor from the moment it exists.
   */
  static async registerWithOtp(
    rawIdentifier: string,
    code: string,
    password: string,
    businessName: string,
    serviceCategory: string
  ): Promise<{ accessToken: string; refreshToken: string; vendorId: string }> {
    const id = classifyIdentifier(rawIdentifier);

    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const name = (businessName ?? '').trim();
    if (!name) {
      throw new Error('Business name is required');
    }
    if (name.length > MAX_BUSINESS_NAME_LENGTH) {
      throw new Error(`Business name cannot exceed ${MAX_BUSINESS_NAME_LENGTH} characters`);
    }
    if (!BUSINESS_CATEGORIES.includes(serviceCategory as BusinessCategory)) {
      throw new Error('Choose a valid business category');
    }

    // Guard against a race / double-submit where the account was created
    // between requestRegistrationOtp and here.
    const existing = await this.findByIdentifier(id);
    if (existing) {
      throw new Error('This account already exists. Please sign in instead.');
    }

    await OtpService.consumeOtp(id, code);

    const { accessToken, refreshToken, user } = await TicketsAuthService.register({
      businessName: name,
      ...(id.channel === 'email' ? { email: id.value } : { phoneNumber: id.value }),
      password,
      accountKind: AccountKind.BUSINESS,
      serviceCategory,
    });

    return { accessToken, refreshToken, vendorId: String(user._id) };
  }
}
