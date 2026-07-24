import mongoose, { Schema, Document, Types } from 'mongoose';

export type StorySeenActorType = 'buyer' | 'vendor';

/**
 * One row per (story, viewer) — marks that the viewer has seen a story.
 * Mirrors @models/updateReaction.model's actor shape: `buyerId` holds the
 * viewing actor's id regardless of actorType (a Buyer _id when 'buyer', a
 * Vendor _id when 'vendor'), disambiguated by actorType.
 */
export interface IStorySeen extends Document {
  storyId: Types.ObjectId;
  buyerId: Types.ObjectId;
  actorType: StorySeenActorType;
  createdAt: Date;
}

const storySeenSchema = new Schema<IStorySeen>({
  storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One seen-mark per (story, viewer) — markSeen is an idempotent upsert against this.
storySeenSchema.index({ storyId: 1, actorType: 1, buyerId: 1 }, { unique: true });

export const StorySeen = mongoose.model<IStorySeen>('StorySeen', storySeenSchema);
