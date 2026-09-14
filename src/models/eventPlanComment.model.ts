import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A public comment (or reply, one level deep) on a Public Event Plan —
 * distinct from the plan's members-only conversation (EventPlanMessage).
 * "Interact with every Public Event Plan in the same way they interact with
 * a normal post" — mirrors VoteComment's shape (parentId + replyCount +
 * likeCount) since that feature already covers "post comments / reply to
 * comments / like individual comments" for a different threaded surface.
 *
 * Soft-deleted (status:'removed'), matching VoteComment/UpdateComment: the
 * parent plan's commentCount (and a parent comment's replyCount) is
 * decremented at the same time, and a removed comment must never resurface
 * in a list read.
 */
export interface IEventPlanComment extends Document {
  planId: Types.ObjectId;
  parentId?: Types.ObjectId;
  authorType: SocialActorType;
  authorId: Types.ObjectId;
  body: string;
  status: 'active' | 'removed';
  removedBy?: string;
  replyCount: number;
  likeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IEventPlanComment>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'EventPlan', required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'EventPlanComment' },
    authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
    removedBy: { type: String },
    replyCount: { type: Number, default: 0 },
    likeCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Top-level comments for a plan, newest first.
schema.index({ planId: 1, parentId: 1, status: 1, createdAt: -1 });
// Replies for one parent comment, oldest first (thread read order).
schema.index({ parentId: 1, status: 1, createdAt: 1 });

export const EventPlanComment = mongoose.model<IEventPlanComment>('EventPlanComment', schema);
