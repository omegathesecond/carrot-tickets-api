import { Schema, model, Document } from 'mongoose';

/**
 * One-time record of a consumed social SSO handoff. The handoff itself is a
 * short-lived JWT; recording its `jti` on exchange makes it single-use. The
 * TTL index self-cleans spent records (a handoff can't outlive its 90s JWT
 * anyway, so 5 min is ample slack).
 */
export interface IHandoffToken extends Document {
  jti: string;
  createdAt: Date;
}

const schema = new Schema<IHandoffToken>(
  { jti: { type: String, required: true, unique: true } },
  { timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

export const HandoffToken = model<IHandoffToken>('HandoffToken', schema);
