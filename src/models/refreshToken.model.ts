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
    expiresAt: { type: Date, required: true, index: true },
    isRevoked: { type: Boolean, default: false },
    deviceInfo: { type: String }
  },
  { timestamps: true }
);

// Auto-delete expired tokens (MongoDB TTL index)
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema);
