import { encryptOperatorPin } from '@utils/operatorPinEncryption.util';
// api/src/models/operatorCredentials.schema.ts
import { Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { OPERATOR_GRANTS } from '@interfaces/operatorGrant.interface';

/**
 * Shared credential mechanism for PIN-login operators (reseller + gate).
 * Adds the pin field (hashed, never serialized), lockout bookkeeping, a
 * bcrypt pre-save hash hook, and a comparePin() method.
 */
export function applyOperatorCredentials(schema: Schema, recoverablePin = false): void {
  schema.add({
    // Per-person capability grants on top of the role's fixed set (see
    // OperatorGrant). Enum-validated so a typo is a write error, and filtered
    // AGAIN at token-mint time so a value that stops being a grant later
    // cannot keep widening old rows' tokens.
    grants: { type: [{ type: String, enum: OPERATOR_GRANTS }], default: [] },
    pin: { type: String, required: [true, 'PIN is required'], select: false },
    failedPinAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date },
  });

  if (recoverablePin) {
    schema.add({ encryptedPin: { type: String, select: false } });
    for (const option of ['toJSON', 'toObject'] as const) {
      const original = schema.get(option) || {};
      const transform = original.transform;
      schema.set(option, { ...original, transform: (doc: any, ret: any, opts: any) => {
        delete ret.encryptedPin;
        return typeof transform === 'function' ? transform(doc, ret, opts) : ret;
      } });
    }
  }

  schema.pre('save', async function (next) {
    try {
      if (this.isModified('pin')) {
        if (recoverablePin) {
          this.set('encryptedPin', encryptOperatorPin(String(this.get('pin')), String(this._id)));
        }
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
