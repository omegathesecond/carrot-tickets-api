import { Schema, model, Document, Types } from 'mongoose';

/**
 * A direct conversation: 1:1 (exactly 2 participants, deduped by pairKey)
 * or a small group (3..10, isGroup). readState maps buyerId -> last read
 * time for unread badges. Messages live in the shared Message model with
 * dmThreadId set.
 */
export interface IDmThread extends Document {
  participants: Types.ObjectId[];
  isGroup: boolean;
  createdBy: Types.ObjectId;
  pairKey?: string;
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
        validator: (v: Types.ObjectId[]) => Array.isArray(v) && v.length >= 2 && v.length <= 10,
        message: 'A conversation has 2-10 participants',
      },
    },
    isGroup: { type: Boolean, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    pairKey: { type: String }, // only for 1:1 threads
    lastMessageAt: { type: Date },
    readState: { type: Map, of: Date, default: {} },
  },
  { timestamps: true }
);

dmThreadSchema.index({ pairKey: 1 }, { unique: true, sparse: true });
// "My conversations" listing.
dmThreadSchema.index({ participants: 1, lastMessageAt: -1 });

export const DmThread = model<IDmThread>('DmThread', dmThreadSchema);
