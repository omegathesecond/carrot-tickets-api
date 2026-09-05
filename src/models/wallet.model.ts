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
  /**
   * The ticket this wallet belongs to, when there is one. ABSENT for a
   * standalone tag handed out at the Register desk: such a wallet is identified
   * by its band instead (design 2026-09-05). Exactly one of ticketId/bandUid is
   * required — see the pre-validate hook below.
   */
  ticketId?: mongoose.Types.ObjectId;
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

// {PATH} is interpolated by Mongoose with the offending field name, so this is
// shared across balance and cashFundedBalance without either reporting the
// other's name.
const integerCents = {
  validator: Number.isSafeInteger,
  message: '{PATH} must be integer minor units (ZAR cents)',
};

const walletSchema = new Schema<IWallet>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    // NOTE: no unique/index/sparse here on purpose — uniqueness is declared once,
    // below, via schema.index(). Declaring it in both places yields two
    // definitions of the same index name with different options; MongoDB rejects
    // the second and Mongoose swallows the error, so the index silently never
    // exists.
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket' },
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
  {
    timestamps: true,
    // The ticketId index changed from plain-unique to PARTIAL-unique
    // (design 2026-09-05). Mongoose's default connection-level autoIndex would
    // race migrateWalletIndexes() (called at app.ts boot, non-test envs only)
    // to rebuild this collection's indexes the instant the model registers on
    // an open connection — and if that background build wins while the legacy
    // non-partial ticketId_1 still exists, it throws IndexKeySpecsConflict and
    // the partial version never lands. Same trap, same fix as review.model.ts.
    // Left on for NODE_ENV==='test': the suite's ephemeral in-memory Mongo
    // relies on autoIndex (and explicit syncIndexes) to build these before
    // assertions run. See src/scripts/migrate-wallet-indexes.ts.
    autoIndex: process.env['NODE_ENV'] === 'test',
  },
);

/**
 * !! THE cashFundedBalance <= balance INVARIANT IS NOT ENFORCED ON UPDATES !!
 *
 * This hook — and every `min`/`validate` rule declared above — runs ONLY on
 * save() and create(). It does NOT run on updateOne / findOneAndUpdate /
 * updateMany / bulkWrite: Mongoose skips document validators on update paths
 * unless `runValidators: true` is passed per-call, and there is no global plugin
 * setting it here. `$inc` bypasses validation regardless, since there is no full
 * document to validate. A cross-field check like this one cannot be expressed
 * under `runValidators` at all, because an update validator only ever sees the
 * single path it is validating — never the sibling it must compare against.
 *
 * Consequence: ANY code mutating `balance` or `cashFundedBalance` outside
 * save()/create() MUST preserve the invariant ITSELF. Nothing will catch it.
 *
 * The intended pattern is ONE atomic aggregation-pipeline update that moves both
 * fields together, with a $max floor keeping cashFundedBalance at or above 0
 * once a spend has drawn it fully down (spec §2.4 — cash is spent FIRST so the
 * residual is maximally auto-refundable to a card):
 *
 *   Wallet.findOneAndUpdate(
 *     { _id, status: 'active', balance: { $gte: amount } },   // CAS guard
 *     [{ $set: {
 *         balance:           { $subtract: ['$balance', amount] },
 *         cashFundedBalance: { $max: [0, { $subtract: ['$cashFundedBalance', amount] }] },
 *     } }],
 *     { new: true },
 *   )
 *
 * The filter is the compare-and-set: it is what makes the read-modify-write safe
 * under concurrent taps, and a null result means "insufficient funds or not
 * active", NOT an error to swallow.
 *
 * NOTE ON BACKSTOPS: there is currently NO automated detector for
 * cashFundedBalance > balance drift. ReconciliationService.checkInvariant() and
 * checkJournalIntegrity() reconcile the LEDGER only (spec §3) — they never read
 * Wallet documents, so this specific drift is invisible to them. Do not rely on
 * reconciliation to catch a caller that violates the invariant.
 *
 * Do NOT delete this hook: it still guards create()/save(), which is where
 * wallets are minted and where a bad seed would otherwise start life invalid.
 */
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
// One wallet per ticket. PARTIAL for the same reason as the bandUid index
// above: a wallet handed out as a standalone tag carries no ticketId, and a
// plain unique index would index every one of those as null and reject the
// second. Indexes only wallets that actually belong to a ticket, which keeps
// ensureWalletForTicket's upsert concurrency-safe.
//
// CHANGED from a plain unique index (design 2026-09-05). Mongoose never
// rewrites an existing index's options in place, so the legacy `ticketId_1`
// must be dropped before this one can be built under the same name — see
// scripts/migrate-wallet-indexes.ts, which runs at boot.
walletSchema.index(
  { ticketId: 1 },
  { unique: true, partialFilterExpression: { ticketId: { $exists: true } } },
);
// Non-partial: checkWalletBalances scans ALL wallets in an event (bound or not),
// which the partial {eventId,bandUid} index cannot serve.
walletSchema.index({ eventId: 1 });

// A wallet with neither a ticket nor a band is reachable by no lookup — every
// money path finds a wallet by one or the other — and so could never be topped
// up, spent, cashed out or reconciled. Refuse it at the door rather than create
// an unmanageable row (the same reasoning that refuses an organizer-scope gate
// operator with no vendorId).
walletSchema.pre('validate', function (next) {
  if (!this.ticketId && !this.bandUid) {
    next(new Error('A wallet needs a ticket or a band — one of ticketId/bandUid is required'));
    return;
  }
  next();
});

export const Wallet = mongoose.model<IWallet>('Wallet', walletSchema);
