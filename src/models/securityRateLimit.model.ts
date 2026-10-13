import { Schema, model } from 'mongoose';

interface SecurityRateLimitRecord {
  _id: string;
  count: number;
  resetAt: Date;
  expiresAt: Date;
}

const schema = new Schema<SecurityRateLimitRecord>({
  _id: { type: String, required: true },
  count: { type: Number, required: true },
  resetAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SecurityRateLimit = model<SecurityRateLimitRecord>('SecurityRateLimit', schema);
