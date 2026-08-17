import mongoose, { Schema, Document } from 'mongoose';

/**
 * Append-only audit trail of band UID <-> wallet bindings (cashless spec §4).
 *
 * A UID-only band is cloneable, so "which band was live on this wallet, and
 * when" must remain answerable after the fact — for lost-band reissue and for
 * clone/fraud investigation. Rows are never mutated except to stamp unboundAt.
 */
export interface IBandBinding extends Document {
  walletId: mongoose.Types.ObjectId;
  eventId: mongoose.Types.ObjectId;
  bandUid: string;
  boundAt: Date;
  unboundAt?: Date;
  unboundReason?: string;
  /** The operator who bound it, when known (a GateOperator at check-in). */
  boundBy?: string;
  createdAt: Date;
}

const bandBindingSchema = new Schema<IBandBinding>(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    bandUid: { type: String, required: true, trim: true },
    boundAt: { type: Date, default: Date.now },
    unboundAt: { type: Date },
    unboundReason: { type: String, trim: true },
    boundBy: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// History for one wallet, newest first.
bandBindingSchema.index({ walletId: 1, boundAt: -1 });
// "Where has this UID ever been seen in this event?" — the clone-forensics path.
bandBindingSchema.index({ eventId: 1, bandUid: 1, boundAt: -1 });

export const BandBinding = mongoose.model<IBandBinding>('BandBinding', bandBindingSchema);
