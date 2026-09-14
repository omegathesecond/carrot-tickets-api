import mongoose, { Schema, Document, Types } from 'mongoose';

export type PlanCommentReactionActorType = 'buyer' | 'vendor';

/**
 * "Like individual comments" on a Public Event Plan's comment thread —
 * mirrors VoteCommentReaction (including its `buyerId` field name for the
 * actor id) so @services/reactions.service#toggleReactionGeneric applies
 * unchanged here too.
 */
export interface IEventPlanCommentReaction extends Document {
  commentId: Types.ObjectId;
  actorType: PlanCommentReactionActorType;
  buyerId: Types.ObjectId;
  type: 'like';
  createdAt: Date;
}

const schema = new Schema<IEventPlanCommentReaction>(
  {
    commentId: { type: Schema.Types.ObjectId, ref: 'EventPlanComment', required: true, index: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    buyerId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['like'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ commentId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });

export const EventPlanCommentReaction = mongoose.model<IEventPlanCommentReaction>('EventPlanCommentReaction', schema);
