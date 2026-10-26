import mongoose, { Schema, Document, Types } from 'mongoose';

export type VoteQuestionKind = 'artist' | 'song' | 'outfit' | 'attend' | 'attending_with' | 'busy' | 'bump_into' | 'cup' | `custom_${string}`;

export interface IVoteOption {
  key: string;
  label: string;
}

/** One question per event and kind. Custom kinds carry a stable custom_ ID.
 * Defaults are materialized from event details. Explicit fanQuestions on
 * the event control the visible selection and synchronize prompt/options;
 * question IDs remain stable so editing labels preserves responses.
 */
export interface IVoteQuestion extends Document {
  eventId: Types.ObjectId;
  kind: VoteQuestionKind;
  prompt: string;
  order: number;
  options: IVoteOption[];
  createdAt: Date;
  updatedAt: Date;
}

const voteOptionSchema = new Schema<IVoteOption>(
  {
    key: { type: String, required: true, trim: true, maxlength: 120 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { _id: false },
);

const schema = new Schema<IVoteQuestion>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    kind: { type: String, validate: (kind: string) => ['artist', 'song', 'outfit', 'attend', 'attending_with', 'busy', 'bump_into', 'cup'].includes(kind) || /^custom_[a-zA-Z0-9_-]{1,80}$/.test(kind), required: true },
    prompt: { type: String, required: true, trim: true, maxlength: 200 },
    order: { type: Number, required: true, default: 0 },
    options: { type: [voteOptionSchema], default: [] },
  },
  { timestamps: true },
);

// One question of each kind per event — enforced at the DB, not just by
// ensureVoteQuestions's find-before-create, so a concurrent materialization
// race can't double-create (the loser's insert 11000s and re-reads).
schema.index({ eventId: 1, kind: 1 }, { unique: true });
// Serves "this event's questions, in display order".
schema.index({ eventId: 1, order: 1 });

export const VoteQuestion = mongoose.model<IVoteQuestion>('VoteQuestion', schema);
