import mongoose, { Schema, Document, Types } from 'mongoose';

export type ReactionActorType = 'buyer' | 'vendor';

/** Mirrors EventReaction (see eventReaction.model.ts) for the Q&A "like a
 *  question" action — same shape, scoped to questionId instead of eventId. */
export interface IEventQuestionReaction extends Document {
  questionId: Types.ObjectId;
  /** The reacting actor's id. Holds a Buyer _id when actorType='buyer', a Vendor _id when 'vendor'. */
  buyerId: Types.ObjectId;
  actorType: ReactionActorType;
  type: 'like';
  createdAt: Date;
}

const schema = new Schema<IEventQuestionReaction>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'EventQuestion', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    // Enum with a single member today, mirroring EventReaction/UpdateReaction.
    type: { type: String, enum: ['like'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One reaction of each type per (question, actor). actorType disambiguates the
// (theoretical) case of a Buyer and Vendor sharing an ObjectId value.
schema.index({ questionId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });

export const EventQuestionReaction = mongoose.model<IEventQuestionReaction>('EventQuestionReaction', schema);
