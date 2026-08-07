import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A per-actor read cursor for one EventQuestion (topic). `lastViewedAt` is
 * bumped to now() whenever the actor opens the thread (POST
 * /api/community/questions/:id/read); the "unread" badge on the TopicsPage
 * YOUR TOPICS list counts replies newer than this that the actor did NOT
 * write themselves.
 *
 * A missing row means the actor has never opened that thread — so every
 * reply by someone else is unread, exactly like a chat you've never tapped
 * into. Keyed on the same (actorType, actorId) actor vocabulary as
 * EventQuestion/EventQuestionReply (a buyer OR an organizer brand).
 */
export interface IEventQuestionRead extends Document {
  questionId: Types.ObjectId;
  actorType: SocialActorType;
  actorId: Types.ObjectId;
  lastViewedAt: Date;
}

const schema = new Schema<IEventQuestionRead>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'EventQuestion', required: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    lastViewedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One cursor per (actor, question); also the exact shape of the batch lookup
// listMine does (all of one actor's cursors for a set of questions).
schema.index({ actorType: 1, actorId: 1, questionId: 1 }, { unique: true });

export const EventQuestionRead = mongoose.model<IEventQuestionRead>('EventQuestionRead', schema);
