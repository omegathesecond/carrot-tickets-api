import type { Model } from 'mongoose';
import type { SocialActor } from '@utils/socialActor.util';

export interface ToggleInput {
  /** The reaction collection, e.g. UpdateReaction / EventReaction. */
  reactionModel: Model<any>;
  /** The reacted-to collection, whose counter is adjusted, e.g. Update / Event. */
  targetModel: Model<any>;
  /** The reaction field holding the target's id — 'updateId' | 'eventId'. */
  targetField: string;
  targetId: string;
  actor: SocialActor;
  /** 'like' | 'save' — matched against the reaction's `type` enum. */
  type: string;
  /** The target's counter for this reaction type — 'likeCount' | 'saveCount'. */
  counterField: string;
}

/**
 * Toggle one actor's reaction on one target, keeping the target's counter in
 * sync. Shared by updates and events so the toggle semantics (and the
 * off-by-one risk in the $inc) live in exactly one place.
 *
 * Returns only `active`; the caller re-reads whichever counters it wants to
 * return, since Update exposes likeCount+saveCount while Event exposes
 * likeCount only.
 */
export async function toggleReactionGeneric({
  reactionModel,
  targetModel,
  targetField,
  targetId,
  actor,
  type,
  counterField,
}: ToggleInput): Promise<{ active: boolean }> {
  const key = { [targetField]: targetId, actorType: actor.type, buyerId: actor.id, type };
  const existing = await reactionModel.findOne(key);
  if (existing) {
    await existing.deleteOne();
    await targetModel.updateOne({ _id: targetId }, { $inc: { [counterField]: -1 } });
    return { active: false };
  }
  await reactionModel.create(key);
  await targetModel.updateOne({ _id: targetId }, { $inc: { [counterField]: 1 } });
  return { active: true };
}
