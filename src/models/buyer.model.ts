import { Schema, model, Document } from 'mongoose';
import bcrypt from 'bcrypt';

/**
 * Buyer (ticket-holder) account for the public site.
 *
 * Buyers authenticate with phone + password — no SMS one-time codes. The
 * phone is the unique identity (tickets are keyed off customerPhone, so the
 * minted JWT carries `userPhone` and the existing "My Tickets" lookup keeps
 * working unchanged). Passwords are bcrypt-hashed via the pre-save hook and
 * are never returned by default (`select: false`).
 */
export interface IBuyer extends Document {
  phone: string; // normalised, e.g. +26878422613
  password: string; // bcrypt hash (select: false)
  name?: string;
  avatarUrl?: string; // public R2 URL of the buyer's profile picture (optional)
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const buyerSchema = new Schema<IBuyer>(
  {
    phone: { type: String, required: true, unique: true, index: true, trim: true },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters long'],
      select: false
    },
    name: { type: String, trim: true, maxlength: 100 },
    avatarUrl: { type: String, trim: true },
    lastLoginAt: { type: Date }
  },
  { timestamps: true }
);

// Hash the password whenever it is set/changed.
buyerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err as Error);
  }
});

buyerSchema.methods.comparePassword = async function (
  this: IBuyer,
  candidate: string
): Promise<boolean> {
  return bcrypt.compare(candidate, (this as any).password);
};

export const Buyer = model<IBuyer>('Buyer', buyerSchema);
