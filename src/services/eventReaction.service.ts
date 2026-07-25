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

/** Toggle the actor's SAVE (bookmark) on an event — independent of toggleEventLike;
 *  a 'save' EventReaction row is entirely separate from a 'like' row (see the
 *  unique index in eventReaction.model.ts, keyed on `type` too). */
export async function toggleEventSave(eventId: string, actor: SocialActor) {
  const { active } = await toggleReactionGeneric({
    reactionModel: EventReaction,
    targetModel: Event,
    targetField: 'eventId',
    targetId: eventId,
    actor,
    type: 'save',
    counterField: 'saveCount',
  });
  const e = await Event.findById(eventId).select('saveCount').lean();
  return { active, saveCount: e?.saveCount ?? 0 };
}

export async function recordEventShare(eventId: string): Promise<{ shareCount: number }> {
  const e = await Event.findByIdAndUpdate(eventId, { $inc: { shareCount: 1 } }, { new: true })
    .select('shareCount')
    .lean();
  return { shareCount: e?.shareCount ?? 0 };
}

/**
 * Batch-resolve "did this viewer like/save each of these events?" in ONE
 * query. The feed calls this once per page — a per-slide call would be N
 * round-trips. Mirrors update.service's getViewerReactions ({liked, saved}
 * shape) so a card's bookmark state can be restored after reload, same as an
 * update's.
 */
export async function getViewerEventReactions(
  eventIds: string[],
  actor: SocialActor
): Promise<Record<string, { liked: boolean; saved: boolean }>> {
  const map: Record<string, { liked: boolean; saved: boolean }> = {};
  for (const id of eventIds) map[String(id)] = { liked: false, saved: false };
  if (eventIds.length === 0) return map;

  const rows = await EventReaction.find({
    eventId: { $in: eventIds },
    actorType: actor.type,
    buyerId: actor.id,
    type: { $in: ['like', 'save'] },
  }).lean();

  for (const r of rows) {
    const k = String(r.eventId);
    if (!map[k]) map[k] = { liked: false, saved: false };
    if (r.type === 'like') map[k].liked = true;
    if (r.type === 'save') map[k].saved = true;
  }
  return map;
}
