import { Schema, model, Document } from 'mongoose';

export type OtpChannel = 'sms' | 'email';

/**
 * One-time passcode for buyer (ticket holder) login on the public site.
 *
 * Buyers don't have passwords — they prove ownership of the phone number or email
 * their tickets were bought against. We store only a SHA-256 hash of the
 * code (never the plaintext), cap verification attempts, and let MongoDB's
 * TTL index sweep expired/used rows.
 */
export interface IBuyerOtp extends Document {
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
    channel: { type: String, enum: ['sms', 'email'], required: true },
    destination: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    // No `index: true` here — that built a plain "expiresAt_1" which then made
    // MongoDB REJECT the TTL index below (same name, different options), so
    // expired OTPs were never actually purged. The TTL index is the intent.
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// Auto-delete once expired (TTL).
buyerOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BuyerOtp = model<IBuyerOtp>('BuyerOtp', buyerOtpSchema);
