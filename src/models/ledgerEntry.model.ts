import mongoose, { Schema, Document } from 'mongoose';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

/**
 * One leg of a balanced double-entry transaction (spec §3).
 *
 * Entries are grouped by `txnId`; the postings of a txnId always sum to
 * exactly 0 (debit-positive convention). Entries are append-only and are
 * written ONLY by LedgerService.post().
 */
export interface ILedgerEntry extends Document {
  eventId: mongoose.Types.ObjectId;
  txnId: string;
  accountType: LedgerAccountType;
  accountRef: string | null;
  /** Signed amount in ZAR cents. > 0 debit, < 0 credit. */
  delta: number;
  tag?: FloatTag;
  refType: string;
  refId: string;
  createdAt: Date;
}

const ledgerEntrySchema = new Schema<ILedgerEntry>(
  {
    // No `index: true`: eventId_1 would be a strict prefix of the compound
    // {eventId, accountType, accountRef} index below, which already serves
    // eventId-only queries. A second index is pure write amplification on the
    // hottest insert path in the system.
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    txnId: { type: String, required: true, index: true },
    accountType: {
      type: String,
      enum: Object.values(LedgerAccountType),
      required: true,
    },
    accountRef: { type: String, default: null },
    delta: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'delta must be integer minor units (ZAR cents)',
      },
    },
    tag: { type: String, enum: Object.values(FloatTag), required: false },
    refType: { type: String, required: true },
    refId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Balance derivation: sum deltas for one account within an event.
ledgerEntrySchema.index({ eventId: 1, accountType: 1, accountRef: 1 });
// Provenance lookups (e.g. "show me the postings for this top-up").
ledgerEntrySchema.index({ refType: 1, refId: 1 });

export const LedgerEntry = mongoose.model<ILedgerEntry>('LedgerEntry', ledgerEntrySchema);
