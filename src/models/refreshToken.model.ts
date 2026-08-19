import { Schema, model, Document } from 'mongoose';

export interface IRefreshToken extends Document {
  token: string;
  userId?: string;
  vendorId?: string;
  userType: 'vendor' | 'sub-user';
  expiresAt: Date;
  createdAt: Date;
  isRevoked: boolean;
  deviceInfo?: string;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: String },
    vendorId: { type: String },
    userType: { type: String, required: true, enum: ['vendor', 'sub-user'] },
    // No `index: true` here — that built a plain "expiresAt_1" which then made
    // MongoDB REJECT the TTL index below (same name, different options), so
    // expired tokens were never actually purged. The TTL index is the intent.
    expiresAt: { type: Date, required: true },
    isRevoked: { type: Boolean, default: false },
    deviceInfo: { type: String }
  },
  { timestamps: true }
);

// Auto-delete expired tokens (MongoDB TTL index)
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema);
