import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A comment on an Update (the photo/video posts in the Discover feed).
 *
 * authorType/authorId follow the same actor vocabulary as Update and
 * EventQuestion — a ticket-buyer or an organizer brand (Vendor) can both
 * comment, so the brand can reply to its own audience under a post.
 *
 * Soft-deleted (status:'removed') rather than dropped, matching Update: the
 * count on the parent is decremented at the same time, and a removed comment
 * must never resurface in a list read.
 */
export interface IUpdateComment extends Document {
  updateId: Types.ObjectId;
  authorType: SocialActorType;
  authorId: Types.ObjectId;
  body: string;
  status: 'active' | 'removed';
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IUpdateComment>(
  {
    updateId: { type: Schema.Types.ObjectId, ref: 'Update', required: true, index: true },
    authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
  },
  { timestamps: true },
);

// Serves the ONE list read: "active comments on this post, newest first",
// including the createdAt cursor range — status is in the key so removed rows
// are skipped in the index rather than fetched and filtered.
schema.index({ updateId: 1, status: 1, createdAt: -1 });

export const UpdateComment = mongoose.model<IUpdateComment>('UpdateComment', schema);
