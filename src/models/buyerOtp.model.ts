import { Schema, model, Document } from 'mongoose';

export type OtpChannel = 'sms' | 'email';

/**
 * Which account family a code belongs to. Codes are keyed on the raw
 * destination (phone/email), and one person can be BOTH a ticket buyer and an
 * organizer on the same phone/email — so every issue/verify is scoped by
 * `audience` to keep the two flows from clobbering each other's live codes.
 */
export type OtpAudience = 'buyer' | 'vendor';

/**
 * One-time passcode used by two passwordless-proof flows:
 *   - buyer  (audience:'buyer')  — ticket-holder login/registration/reset on the public site
 *   - vendor (audience:'vendor') — organizer (Vendor) password reset on the dashboard
 *
 * The caller proves ownership of the phone number or email; we store only a
 * SHA-256 hash of the code (never the plaintext), cap verification attempts,
 * and let MongoDB's TTL index sweep expired/used rows. The collection name
 * stays `buyerotps` (buyers came first) but the model is audience-agnostic.
 */
export interface IBuyerOtp extends Document {
  audience: OtpAudience;              // 'buyer' or 'vendor'
  channel: OtpChannel;                // 'sms' or 'email'
  destination: string;                // normalised phone or lowercased email
  codeHash: string;                   // sha256(code)
  expiresAt: Date;
  attempts: number;
  consumed: boolean;
  createdAt: Date;
}

const buyerOtpSchema = new Schema<IBuyerOtp>(
  {
    audience: { type: String, enum: ['buyer', 'vendor'], required: true, index: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    destination: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// Auto-delete once expired (TTL).
buyerOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BuyerOtp = model<IBuyerOtp>('BuyerOtp', buyerOtpSchema);
