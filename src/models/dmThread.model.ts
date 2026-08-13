import { Schema, model, Document, Types } from 'mongoose';

/**
 * A direct conversation: 1:1 (exactly 2 participants, deduped by pairKey)
 * or a small group (3..10, isGroup). readState maps buyerId -> last read
 * time for unread badges. Messages live in the shared Message model with
 * dmThreadId set.
 */
export interface IDmThread extends Document {
  participants: Types.ObjectId[];
  /** Set on a brand↔buyer thread: the organizer (Vendor) party. The buyer
   *  stays in `participants`, so all buyer-side DM code is unchanged. */
  vendorParticipantId?: Types.ObjectId;
  /** Set on a brand↔brand thread: the TWO organizer (Vendor) parties. No buyer
   *  is involved so `participants` is empty — this is the only identity list. */
  vendorParticipantIds?: Types.ObjectId[];
  isGroup: boolean;
  /** The buyer who created a buyer-side thread. Absent on a brand↔brand thread
   *  (no buyer party). Write-only provenance — nothing reads it. */
  createdBy?: Types.ObjectId;
  pairKey?: string;
  /** 1:1 dedupe for a brand↔buyer thread (`v:<vendorId>:<buyerId>`). */
  vendorPairKey?: string;
  /** 1:1 dedupe for a brand↔brand thread (`vv:<loVendorId>:<hiVendorId>`). */
  brandPairKey?: string;
  lastMessageAt?: Date;
  readState: Map<string, Date>;
  createdAt: Date;
  updatedAt: Date;
}

const dmThreadSchema = new Schema<IDmThread>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Buyer' }],
      required: true,
      validate: {
        // A conversation needs ≥2 identities. Buyer↔buyer: 2-10 buyers.
        // Brand↔buyer: 1 buyer + vendorParticipantId. Brand↔brand: 0 buyers +
        // 2 vendorParticipantIds. Buyers alone still cap at 10.
        validator: function (this: IDmThread, v: Types.ObjectId[]) {
          if (!Array.isArray(v) || v.length > 10) return false;
          const identities = v.length + (this.vendorParticipantId ? 1 : 0) + (this.vendorParticipantIds?.length ?? 0);
          return identities >= 2;
        },
        message: 'A conversation has 2-10 participants',
      },
    },
    vendorParticipantId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    // `default: undefined` keeps non-brand↔brand threads out of the multikey
    // index (no empty array stored) — only real brand↔brand threads get indexed.
    vendorParticipantIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Vendor' }], default: undefined },
    isGroup: { type: Boolean, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Buyer' },
    pairKey: { type: String }, // only for 1:1 threads
    vendorPairKey: { type: String },
    brandPairKey: { type: String },
    lastMessageAt: { type: Date },
    readState: { type: Map, of: Date, default: {} },
  },
  { timestamps: true }
);

dmThreadSchema.index({ pairKey: 1 }, { unique: true, sparse: true });
dmThreadSchema.index({ vendorPairKey: 1 }, { unique: true, sparse: true });
dmThreadSchema.index({ brandPairKey: 1 }, { unique: true, sparse: true });
// "My conversations" listing.
dmThreadSchema.index({ participants: 1, lastMessageAt: -1 });
// A brand's conversations listing (brand↔buyer, and brand↔brand).
dmThreadSchema.index({ vendorParticipantId: 1, lastMessageAt: -1 });
dmThreadSchema.index({ vendorParticipantIds: 1, lastMessageAt: -1 });

export const DmThread = model<IDmThread>('DmThread', dmThreadSchema);
