import { Event } from '@models/event.model';
import { EventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import { EventQuestionReaction } from '@models/eventQuestionReaction.model';
import { EventQuestionRead } from '@models/eventQuestionRead.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor, SocialActorType } from '@utils/socialActor.util';

/**
 * Author hydration, inlined. It mirrors the private loadAuthorMaps/authorDto in
 * eventQuestion.service (extracted to socialAuthor.service on a later branch
 * that hasn't reached main yet). Kept local so this module builds on the
 * deployable base; fold into the shared helper once it lands.
 */
interface AuthorMaps {
  vendors: Map<string, any>;
  buyers: Map<string, any>;
}

async function loadAuthorMaps(items: { authorType: SocialActorType; authorId: unknown }[]): Promise<AuthorMaps> {
  const vendorIds = [...new Set(items.filter((i) => i.authorType === 'vendor').map((i) => String(i.authorId)))];
  const buyerIds = [...new Set(items.filter((i) => i.authorType === 'buyer').map((i) => String(i.authorId)))];
  const [vendors, buyers] = await Promise.all([
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl').lean() : Promise.resolve([]),
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl').lean() : Promise.resolve([]),
  ]);
  return {
    vendors: new Map(vendors.map((v: any) => [String(v._id), v])),
    buyers: new Map(buyers.map((b: any) => [String(b._id), b])),
  };
}

function authorDto(authorType: SocialActorType, authorId: unknown, maps: AuthorMaps) {
  if (authorType === 'vendor') {
    const v = maps.vendors.get(String(authorId));
    return { type: 'organizer', id: String(authorId), name: v?.businessName ?? 'Organizer', avatarUrl: v?.logoUrl ?? null };
  }
  const b = maps.buyers.get(String(authorId));
  return { type: 'buyer', id: String(authorId), name: b?.name ?? null, username: b?.username ?? null, avatarUrl: b?.avatarUrl ?? null };
}

/**
 * "YOUR TOPICS" — the topics (event Q&A questions) an actor started OR replied
 * to, newest-activity first, each carrying its event {id, name, image} and an
 * `unreadCount` of replies the actor hasn't seen.
 *
 * Deliberately a NEW module rather than another export on eventQuestion.service:
 * it needs none of that file's private helpers (author/reply hydration is the
 * shared socialAuthor.service), and keeping it separate avoids colliding with
 * concurrent work there. The DTO is the cross-event `Question` shape the
 * TopicsPage already renders, plus `event.image` and `unreadCount`.
 */

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

function isActorReply(reply: { authorType: string; authorId: unknown }, actor: SocialActor): boolean {
  return reply.authorType === actor.type && String(reply.authorId) === String(actor.id);
}

export async function listMine(actor: SocialActor, limit = DEFAULT_LIMIT): Promise<any[]> {
  const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);

  // The union of "questions I authored" and "questions I replied to". Both are
  // indexed lookups on (authorType, authorId); the reply side is collapsed to
  // distinct questionIds so a thread I answered ten times counts once.
  const [authored, repliedIds] = await Promise.all([
    EventQuestion.find({ authorType: actor.type, authorId: actor.id }).select('_id').lean(),
    EventQuestionReply.find({ authorType: actor.type, authorId: actor.id }).distinct('questionId'),
  ]);

  const ids = [...new Set([...authored.map((q) => String(q._id)), ...repliedIds.map((id) => String(id))])];
  if (ids.length === 0) return [];

  // updatedAt bumps on every replyCount $inc, so it tracks last activity —
  // the newest-first order the design shows.
  const questions = await EventQuestion.find({ _id: { $in: ids } })
    .sort({ updatedAt: -1 })
    .limit(capped)
    .lean();

  const questionIds = questions.map((q) => String(q._id));

  const [replies, likedRows, reads, events] = await Promise.all([
    EventQuestionReply.find({ questionId: { $in: questionIds } }).sort({ createdAt: 1 }).lean(),
    EventQuestionReaction.find({ questionId: { $in: questionIds }, actorType: actor.type, buyerId: actor.id, type: 'like' })
      .select('questionId')
      .lean(),
    EventQuestionRead.find({ actorType: actor.type, actorId: actor.id, questionId: { $in: questionIds } })
      .select('questionId lastViewedAt')
      .lean(),
    Event.find({ _id: { $in: [...new Set(questions.map((q) => String(q.eventId)))] } })
      .select('name posterUrl thumbnailUrl')
      .lean(),
  ]);

  const authorMaps = await loadAuthorMaps([
    ...questions.map((q) => ({ authorType: q.authorType, authorId: q.authorId })),
    ...replies.map((r) => ({ authorType: r.authorType, authorId: r.authorId })),
  ]);

  const likedIds = new Set(likedRows.map((r) => String(r.questionId)));
  const lastViewed = new Map(reads.map((r: any) => [String(r.questionId), r.lastViewedAt as Date]));
  const eventMap = new Map(events.map((e: any) => [String(e._id), e]));

  const repliesByQuestion = new Map<string, any[]>();
  for (const r of replies) {
    const key = String(r.questionId);
    if (!repliesByQuestion.has(key)) repliesByQuestion.set(key, []);
    repliesByQuestion.get(key)!.push(r);
  }

  return questions.map((q) => {
    const id = String(q._id);
    const qReplies = repliesByQuestion.get(id) ?? [];
    const seenAt = lastViewed.get(id);
    // Unread = replies by SOMEONE ELSE newer than my cursor. A thread I've
    // never opened (no cursor) counts every other author's reply; my own
    // replies never count, so answering a topic can't make it look unread.
    const unreadCount = qReplies.filter((r) => !isActorReply(r, actor) && (!seenAt || r.createdAt > seenAt)).length;
    const ev = eventMap.get(String(q.eventId));

    return {
      id,
      eventId: String(q.eventId),
      body: q.body,
      likeCount: q.likeCount,
      replyCount: q.replyCount,
      createdAt: q.createdAt,
      author: authorDto(q.authorType, q.authorId, authorMaps),
      viewerHasLiked: likedIds.has(id),
      replies: qReplies.map((r) => ({
        id: String(r._id),
        body: r.body,
        createdAt: r.createdAt,
        author: authorDto(r.authorType, r.authorId, authorMaps),
      })),
      unreadCount,
      event: { id: String(q.eventId), name: ev?.name ?? null, image: ev?.thumbnailUrl ?? ev?.posterUrl ?? null },
    };
  });
}

/**
 * Mark a topic as read for this actor — bumps (or creates) their read cursor
 * to now, zeroing its unread badge. Idempotent; upsert keyed on the unique
 * (actor, question) index.
 */
export async function markRead(questionId: string, actor: SocialActor): Promise<{ ok: true }> {
  if (!(await EventQuestion.exists({ _id: questionId }))) throw new HttpError(404, 'Topic not found');
  await EventQuestionRead.updateOne(
    { actorType: actor.type, actorId: actor.id, questionId },
    { $set: { lastViewedAt: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}
