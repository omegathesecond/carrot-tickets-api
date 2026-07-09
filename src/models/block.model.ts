import { Schema, model, Document, Types } from 'mongoose';

/**
 * A directed block. Enforcement (spec §5.3): DMs are refused server-side
 * when EITHER direction is blocked; channel messages are hidden
 * client-side using GET /api/social/me/blocks.
 */
export interface IBlock extends Document {
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const blockSchema = new Schema<IBlock>(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    blockedId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
  },
  { timestamps: true }
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
// Reverse-direction lookups (isBlockedEitherWay).
blockSchema.index({ blockedId: 1 });

export const Block = model<IBlock>('Block', blockSchema);
