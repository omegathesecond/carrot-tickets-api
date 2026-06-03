import { Schema, model, Document } from 'mongoose';

/**
 * One-time passcode for buyer (ticket holder) login on the public site.
 *
 * Buyers don't have passwords — they prove ownership of the phone number
 * their tickets were bought against. We store only a SHA-256 hash of the
 * code (never the plaintext), cap verification attempts, and let MongoDB's
 * TTL index sweep expired/used rows.
 */
export interface IBuyerOtp extends Document {
  phone: string;          // normalised, e.g. +26878422613
  codeHash: string;       // sha256(code)
  expiresAt: Date;
  attempts: number;
  consumed: boolean;
  createdAt: Date;
}

const buyerOtpSchema = new Schema<IBuyerOtp>(
  {
    phone: { type: String, required: true, index: true },
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
