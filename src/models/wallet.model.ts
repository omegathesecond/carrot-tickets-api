import mongoose, { Schema, Document } from 'mongoose';

export type WalletStatus = 'active' | 'frozen' | 'closed';

/**
 * A per-event, per-attendee closed-loop wallet (cashless spec §4).
 *
 * The NFC band carries only a UID; THIS is the authoritative balance. That is
 * what makes lost-band deactivate + reissue possible with the balance intact.
 *
 * Deliberately per-event and not a persistent stored balance, to bound float
 * liability and regulatory exposure (spec §2, client-approved).
 */
export interface IWallet extends Document {
  eventId: mongoose.Types.ObjectId;
  /** The attendee, when known. A cash-desk wallet may exist before sign-up. */
  buyerId?: mongoose.Types.ObjectId;
  /** Bound band UID, or null when unbound (never bound, or reported lost). */
  bandUid: string | null;
  /** Authoritative balance in ZAR cents. Mutated only by top-up (SP3) / tap (SP5). */
  balance: number;
  /**
   * The portion of `balance` funded by cash at a desk. Spends draw this down
   * FIRST (spec §2.4) so the residual is maximally auto-refundable to a card;
   * whatever remains here must be collected at the office, never auto-swept.
   * Invariant: cashFundedBalance <= balance.
   */
  cashFundedBalance: number;
  status: WalletStatus;
  currency: string;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const integerCents = {
  validator: Number.isSafeInteger,
  message: 'balance must be integer minor units (ZAR cents)',
};

const walletSchema = new Schema<IWallet>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer' },
    // NOTE: no unique/index/sparse here on purpose — the partial unique index is
    // declared once, below. Declaring it in both places yields two definitions of
    // the same index name with different options; MongoDB rejects the second and
    // Mongoose swallows the error, so the index silently never exists.
    bandUid: { type: String, default: null, trim: true },
    balance: { type: Number, default: 0, min: 0, validate: integerCents },
    cashFundedBalance: { type: Number, default: 0, min: 0, validate: integerCents },
    status: { type: String, enum: ['active', 'frozen', 'closed'], default: 'active' },
    currency: { type: String, default: 'ZAR' },
    closedAt: { type: Date },
  },
  { timestamps: true },
);

walletSchema.pre('validate', function (next) {
  if (this.cashFundedBalance > this.balance) {
    return next(new Error('cashFundedBalance cannot exceed balance'));
  }
  next();
});

// One band UID per event. PARTIAL (not sparse): a compound sparse index only
// skips a document missing ALL indexed fields, so every unbound wallet would
// index as {eventId, null} and the second one would collide. The partial filter
// indexes only wallets that actually carry a band.
walletSchema.index(
  { eventId: 1, bandUid: 1 },
  { unique: true, partialFilterExpression: { bandUid: { $type: 'string' } } },
);
// One wallet per attendee per event (closed-loop). This MUST be unique: it is
// what makes ensureWallet()'s upsert concurrency-safe — an upsert only
// serialises concurrent callers when a unique index backs its filter, otherwise
// two simultaneous check-in scans both miss and both insert. PARTIAL for the
// same reason as bandUid: buyerId is optional (a cash-desk wallet can exist
// before sign-up), so a plain unique index would collide on multiple nulls.
walletSchema.index(
  { eventId: 1, buyerId: 1 },
  { unique: true, partialFilterExpression: { buyerId: { $exists: true } } },
);

export const Wallet = mongoose.model<IWallet>('Wallet', walletSchema);
