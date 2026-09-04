import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Atomic per-buyer-per-UTC-day slot counter for the story-points daily cap.
 * Reserving a slot is a single findOneAndUpdate({ count: { $lt: MAX } }, { $inc: { count: 1 } }),
 * which Mongo serializes per document — that's what makes the cap race-proof
 * under concurrent awardStoryPointsIfEligible() calls, unlike a separate
 * countDocuments() read followed by a create().
 */
export interface IStoryPointsDailyCounter extends Document {
  buyerId: Types.ObjectId;
  day: string; // UTC calendar day, YYYY-MM-DD
  count: number;
}

const storyPointsDailyCounterSchema = new Schema<IStoryPointsDailyCounter>({
  buyerId: { type: Schema.Types.ObjectId, required: true },
  day: { type: String, required: true },
  count: { type: Number, required: true, default: 0 },
});

// One counter doc per buyer per day — the unique index is what lets the
// "ensure it exists" upsert below collide safely under concurrency.
storyPointsDailyCounterSchema.index({ buyerId: 1, day: 1 }, { unique: true });

export const StoryPointsDailyCounter = mongoose.model<IStoryPointsDailyCounter>(
  'StoryPointsDailyCounter',
  storyPointsDailyCounterSchema,
);
