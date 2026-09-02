import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * One persisted point award for a buyer's story upload. Stories themselves
 * TTL-delete after 48h (@models/story.model), so unlike ticket/post points
 * (recomputed live from Ticket/Update, which never expire — see
 * @lib/points.ts on the website) a story's point value can't be re-derived
 * once the Story document is gone. This ledger is the only record it happened.
 */
export interface IStoryPointsAward extends Document {
  buyerId: Types.ObjectId;
  storyId: Types.ObjectId;
  points: number;
  createdAt: Date;
}

const storyPointsAwardSchema = new Schema<IStoryPointsAward>({
  buyerId: { type: Schema.Types.ObjectId, required: true },
  // Unique: one award per story, so a retried finalize call can't double-credit.
  storyId: { type: Schema.Types.ObjectId, required: true, unique: true },
  points: { type: Number, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Total-for-buyer and "how many today" (the daily cap) are the only two
// queries this collection serves — both buyerId-first.
storyPointsAwardSchema.index({ buyerId: 1, createdAt: -1 });

export const StoryPointsAward = mongoose.model<IStoryPointsAward>('StoryPointsAward', storyPointsAwardSchema);
