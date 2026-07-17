import { Event } from '@models/event.model';
import { EventReaction } from '@models/eventReaction.model';
import { toggleReactionGeneric } from '@services/reactions.service';
import type { SocialActor } from '@utils/socialActor.util';

/** Toggle the actor's like on an event. Mirrors update.service's toggleReaction. */
export async function toggleEventLike(eventId: string, actor: SocialActor) {
  const { active } = await toggleReactionGeneric({
    reactionModel: EventReaction,
    targetModel: Event,
    targetField: 'eventId',
    targetId: eventId,
    actor,
    type: 'like',
    counterField: 'likeCount',
  });
  // `?? 0`: events predating the counter have no stored field, and .lean()
  // does not apply the schema default to an absent path.
  const e = await Event.findById(eventId).select('likeCount').lean();
  return { active, likeCount: e?.likeCount ?? 0 };
}

export async function recordEventShare(eventId: string): Promise<{ shareCount: number }> {
  const e = await Event.findByIdAndUpdate(eventId, { $inc: { shareCount: 1 } }, { new: true })
    .select('shareCount')
    .lean();
  return { shareCount: e?.shareCount ?? 0 };
}

/**
 * Batch-resolve "did this viewer like each of these events?" in ONE query.
 * The feed calls this once per page — a per-slide call would be N round-trips.
 */
export async function getViewerEventReactions(
  eventIds: string[],
  actor: SocialActor
): Promise<Record<string, { liked: boolean }>> {
  const map: Record<string, { liked: boolean }> = {};
  for (const id of eventIds) map[String(id)] = { liked: false };
  if (eventIds.length === 0) return map;

  const rows = await EventReaction.find({
    eventId: { $in: eventIds },
    actorType: actor.type,
    buyerId: actor.id,
    type: 'like',
  }).lean();

  for (const r of rows) map[String(r.eventId)] = { liked: true };
  return map;
}
