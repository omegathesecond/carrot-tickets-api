import mongoose, { Schema, Document, Types } from 'mongoose';

export type StoryLikeActorType = 'buyer' | 'vendor';

/**
 * One row per (story, liker) — marks that the actor has liked a story item.
 * Mirrors @models/storySeen.model's actor shape: `buyerId` holds the liking
 * actor's id regardless of actorType (a Buyer _id when 'buyer', a Vendor _id
 * when 'vendor'), disambiguated by actorType. Toggled by story.service#toggleLike
 * (create to like, delete to unlike) rather than the idempotent-upsert shape
 * StorySeen uses, since a like is reversible and a seen-mark isn't.
 */
export interface IStoryLike extends Document {
  storyId: Types.ObjectId;
  buyerId: Types.ObjectId;
  actorType: StoryLikeActorType;
  createdAt: Date;
}

const storyLikeSchema = new Schema<IStoryLike>({
  storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One like per (story, actor) — toggleLike deletes this row to unlike.
storyLikeSchema.index({ storyId: 1, actorType: 1, buyerId: 1 }, { unique: true });

export const StoryLike = mongoose.model<IStoryLike>('StoryLike', storyLikeSchema);
