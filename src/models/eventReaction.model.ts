import mongoose, { Schema, Document, Types } from 'mongoose';

export type ReactionActorType = 'buyer' | 'vendor';

export interface IEventReaction extends Document {
  eventId: Types.ObjectId;
  /** The reacting actor's id. Holds a Buyer _id when actorType='buyer', a Vendor _id when 'vendor'. */
  buyerId: Types.ObjectId;
  actorType: ReactionActorType;
  type: 'like';
  createdAt: Date;
}

const schema = new Schema<IEventReaction>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
  // Enum with a single member today. Mirrors UpdateReaction so adding 'save'
  // later is a one-word change, not a migration.
  type: { type: String, enum: ['like'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One reaction of each type per (event, actor). actorType disambiguates the
// (theoretical) case of a Buyer and Vendor sharing an ObjectId value.
//
// NO BACKFILL NEEDED, unlike UpdateReaction: this collection is new, so every
// row is written by this schema and `default: 'buyer'` applies at insert.
// UpdateReaction's rows predate its actorType field, which is why it needed
// `npm run backfill:social-actor-types` to run before its code shipped.
schema.index({ eventId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });

export const EventReaction = mongoose.model<IEventReaction>('EventReaction', schema);
