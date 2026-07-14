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
  isGroup: boolean;
  createdBy: Types.ObjectId;
  pairKey?: string;
  /** 1:1 dedupe for a brand↔buyer thread (`v:<vendorId>:<buyerId>`). */
  vendorPairKey?: string;
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
        // Buyer↔buyer threads have 2-10 buyers; a brand↔buyer thread has 1
        // buyer + a vendorParticipantId. Total identities must still be ≥2.
        validator: function (this: IDmThread, v: Types.ObjectId[]) {
          if (!Array.isArray(v) || v.length < 1 || v.length > 10) return false;
          return v.length + (this.vendorParticipantId ? 1 : 0) >= 2;
        },
        message: 'A conversation has 2-10 participants',
      },
    },
    vendorParticipantId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    isGroup: { type: Boolean, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    pairKey: { type: String }, // only for 1:1 threads
    vendorPairKey: { type: String },
    lastMessageAt: { type: Date },
    readState: { type: Map, of: Date, default: {} },
  },
  { timestamps: true }
);

dmThreadSchema.index({ pairKey: 1 }, { unique: true, sparse: true });
dmThreadSchema.index({ vendorPairKey: 1 }, { unique: true, sparse: true });
// "My conversations" listing.
dmThreadSchema.index({ participants: 1, lastMessageAt: -1 });
// A brand's conversations listing.
dmThreadSchema.index({ vendorParticipantId: 1, lastMessageAt: -1 });

export const DmThread = model<IDmThread>('DmThread', dmThreadSchema);
