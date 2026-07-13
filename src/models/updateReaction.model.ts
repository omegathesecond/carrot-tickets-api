import mongoose, { Schema, Document, Types } from 'mongoose';

export type ReactionActorType = 'buyer' | 'vendor';

export interface IUpdateReaction extends Document {
  updateId: Types.ObjectId;
  /** The reacting actor's id. Holds a Buyer _id when actorType='buyer', a Vendor _id when 'vendor'. */
  buyerId: Types.ObjectId;
  actorType: ReactionActorType;
  type: 'like' | 'save';
  createdAt: Date;
}

const schema = new Schema<IUpdateReaction>({
  updateId: { type: Schema.Types.ObjectId, ref: 'Update', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
  type: { type: String, enum: ['like', 'save'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One reaction of each type per (update, actor). actorType disambiguates the
// (theoretical) case of a Buyer and Vendor sharing an ObjectId value.
// DEPLOY (one-time, SP1a): the legacy unique index `updateId_1_buyerId_1_type_1`
// (pre-actorType) still exists on the prod collection and should be dropped for
// hygiene — `db.updatereactions.dropIndex('updateId_1_buyerId_1_type_1')`. It is
// harmless if left (distinct actor ids never collide), so this is not urgent.
schema.index({ updateId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });
schema.index({ actorType: 1, buyerId: 1, type: 1, createdAt: -1 }); // "my saved updates"

export const UpdateReaction = mongoose.model<IUpdateReaction>('UpdateReaction', schema);
