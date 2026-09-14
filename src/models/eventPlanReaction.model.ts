import mongoose, { Schema, Document, Types } from 'mongoose';

export type PlanReactionActorType = 'buyer' | 'vendor';

/**
 * Like/save on a Public Event Plan — "interact with every Public Event Plan
 * in the same way they interact with a normal post" (social-engagement
 * follow-up). Mirrors UpdateReaction's shape (including the `buyerId` field
 * name for the actor id, which holds a Vendor _id when actorType='vendor')
 * so @services/reactions.service#toggleReactionGeneric works unchanged here.
 */
export interface IEventPlanReaction extends Document {
  planId: Types.ObjectId;
  buyerId: Types.ObjectId;
  actorType: PlanReactionActorType;
  type: 'like' | 'save';
  createdAt: Date;
}

const schema = new Schema<IEventPlanReaction>({
  planId: { type: Schema.Types.ObjectId, ref: 'EventPlan', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
  type: { type: String, enum: ['like', 'save'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One reaction of each type per (plan, actor).
schema.index({ planId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });
schema.index({ actorType: 1, buyerId: 1, type: 1, createdAt: -1 }); // "my saved plans"

export const EventPlanReaction = mongoose.model<IEventPlanReaction>('EventPlanReaction', schema);
