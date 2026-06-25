// api/src/models/operatorCredentials.schema.ts
import { Schema } from 'mongoose';
import bcrypt from 'bcrypt';

/**
 * Shared credential mechanism for PIN-login operators (reseller + gate).
 * Adds the pin field (hashed, never serialized), lockout bookkeeping, a
 * bcrypt pre-save hash hook, and a comparePin() method.
 */
export function applyOperatorCredentials(schema: Schema): void {
  schema.add({
    pin: { type: String, required: [true, 'PIN is required'], select: false },
    failedPinAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date },
  });

  schema.pre('save', async function (next) {
    try {
      if (this.isModified('pin')) {
        const salt = await bcrypt.genSalt(12);
        (this as any).pin = await bcrypt.hash((this as any).pin, salt);
      }
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  schema.methods['comparePin'] = function (candidate: string): Promise<boolean> {
    return bcrypt.compare(candidate, (this as any).pin);
  };
}
