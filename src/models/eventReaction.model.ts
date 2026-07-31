import mongoose, { Schema, Document, Types } from 'mongoose';

export type ReactionActorType = 'buyer' | 'vendor';

export interface IEventReaction extends Document {
  eventId: Types.ObjectId;
  /** The reacting actor's id. Holds a Buyer _id when actorType='buyer', a Vendor _id when 'vendor'. */
  buyerId: Types.ObjectId;
  actorType: ReactionActorType;
  type: 'like' | 'save';
  createdAt: Date;
}

const schema = new Schema<IEventReaction>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
  // 'save' is a distinct bookmark reaction, independent of 'like' — an actor
  // may hold both a like and a save row for the same event (disambiguated by
  // the unique index below, which includes `type`). Mirrors UpdateReaction's
  // like/save split.
  type: { type: String, enum: ['like', 'save'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One reaction of each type per (event, actor). actorType disambiguates the
// (theoretical) case of a Buyer and Vendor sharing an ObjectId value.
//
// NO BACKFILL NEEDED, unlike UpdateReaction: this collection is new, so every
// row is written by this schema and `default: 'buyer'` applies at insert.
// UpdateReaction's rows predate its actorType field, which is why it needed
// `npm run backfill:social-actor-types` to run before its code shipped.
schema.index({ eventId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });
// Activity feed: global newest-first scan of likes (saves are never shown).
schema.index({ type: 1, createdAt: -1 });

export const EventReaction = mongoose.model<IEventReaction>('EventReaction', schema);
