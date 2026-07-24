import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A question posted on an event's Q&A thread (TopicsPage). authorType/authorId
 * follow the same actor vocabulary as Update/EventReaction — a buyer or the
 * organizer brand (Vendor) can both ask.
 */
export interface IEventQuestion extends Document {
  eventId: Types.ObjectId;
  authorType: SocialActorType;
  authorId: Types.ObjectId;
  body: string;
  likeCount: number;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IEventQuestion>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    likeCount: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Serves "newest questions for this event first" — the TopicsPage's only read.
schema.index({ eventId: 1, createdAt: -1 });

export const EventQuestion = mongoose.model<IEventQuestion>('EventQuestion', schema);
