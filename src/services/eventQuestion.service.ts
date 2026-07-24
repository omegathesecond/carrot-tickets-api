import { Event } from '@models/event.model';
import { EventQuestion, IEventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import { EventQuestionReaction } from '@models/eventQuestionReaction.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { toggleReactionGeneric } from '@services/reactions.service';
import { HttpError } from '@utils/httpError.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import type { SocialActor, SocialActorType } from '@utils/socialActor.util';

const MAX_BODY_LENGTH = 1000;

/**
 * A brand acting as an organizer has no `socialSuspendedAt` — only buyer
 * actors can be suspended (see @utils/socialSuspension.util). Shared by
 * createQuestion/createReply/toggleQuestionLike so a suspended buyer can't
 * post or like world-readable Q&A content.
 */
async function assertActorNotSuspended(actor: SocialActor): Promise<void> {
  if (actor.type !== 'buyer') return;
  const buyer = await Buyer.findById(actor.id);
  if (!buyer) throw new HttpError(404, 'Account not found');
  assertNotSuspended(buyer);
}

interface BuyerAuthorDTO {
  type: 'buyer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
}

interface OrganizerAuthorDTO {
  type: 'organizer';
  id: string;
  name: string;
  avatarUrl: string | null;
}

type AuthorDTO = BuyerAuthorDTO | OrganizerAuthorDTO;

interface AuthoredItem {
  authorType: SocialActorType;
  authorId: unknown;
}

interface AuthorMaps {
  vendors: Map<string, any>;
  buyers: Map<string, any>;
}

/**
 * Batch-load the Vendor/Buyer docs behind a set of (authorType, authorId)
 * pairs in at most two queries total, mirroring
 * UpdateService.buildUpdateSlides — callers (listQuestions, createQuestion,
 * createReply) pass every question+reply row at once so author hydration
 * never becomes one query per row.
 */
async function loadAuthorMaps(items: AuthoredItem[]): Promise<AuthorMaps> {
  const vendorIds = [...new Set(items.filter((i) => i.authorType === 'vendor').map((i) => String(i.authorId)))];
  const buyerIds = [...new Set(items.filter((i) => i.authorType === 'buyer').map((i) => String(i.authorId)))];

  const [vendors, buyers] = await Promise.all([
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : Promise.resolve([]),
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : Promise.resolve([]),
  ]);

  return {
    vendors: new Map(vendors.map((v: any) => [String(v._id), v])),
    buyers: new Map(buyers.map((b: any) => [String(b._id), b])),
  };
}

function authorDto(authorType: SocialActorType, authorId: unknown, maps: AuthorMaps): AuthorDTO {
  if (authorType === 'vendor') {
    const v = maps.vendors.get(String(authorId));
    return { type: 'organizer', id: String(authorId), name: v?.businessName ?? 'Organizer', avatarUrl: v?.logoUrl ?? null };
  }
  const b = maps.buyers.get(String(authorId));
  return { type: 'buyer', id: String(authorId), name: b?.name ?? null, username: b?.username ?? null, avatarUrl: b?.avatarUrl ?? null };
}

function replyDto(reply: any, maps: AuthorMaps) {
  return {
    id: String(reply._id),
    questionId: String(reply.questionId),
    eventId: String(reply.eventId),
    body: reply.body,
    createdAt: reply.createdAt,
    author: authorDto(reply.authorType, reply.authorId, maps),
  };
}

/**
 * Hydrate a batch of raw EventQuestion docs into full DTOs: batches reply
 * loading, author loading (questions AND replies together, via
 * loadAuthorMaps), and the viewer's likes into a bounded number of queries
 * regardless of how many questions/replies are in play — no per-row
 * round-trips. Shared by listQuestions (one event) and listRecent (cross-
 * event) so this hydration exists in exactly one place.
 */
async function hydrateQuestions(questions: any[], actor: SocialActor | null): Promise<any[]> {
  if (questions.length === 0) return [];

  const questionIds = questions.map((q) => String(q._id));
  const replies = await EventQuestionReply.find({ questionId: { $in: questionIds } })
    .sort({ createdAt: 1 })
    .lean();

  const authorMaps = await loadAuthorMaps([
    ...questions.map((q) => ({ authorType: q.authorType, authorId: q.authorId })),
    ...replies.map((r) => ({ authorType: r.authorType, authorId: r.authorId })),
  ]);

  const likedQuestionIds = actor
    ? new Set(
        (
          await EventQuestionReaction.find({
            questionId: { $in: questionIds },
            actorType: actor.type,
            buyerId: actor.id,
            type: 'like',
          }).lean()
        ).map((r) => String(r.questionId)),
      )
    : new Set<string>();

  const repliesByQuestion = new Map<string, any[]>();
  for (const r of replies) {
    const key = String(r.questionId);
    if (!repliesByQuestion.has(key)) repliesByQuestion.set(key, []);
    repliesByQuestion.get(key)!.push(r);
  }

  return questions.map((q) => {
    const id = String(q._id);
    return {
      id,
      eventId: String(q.eventId),
      body: q.body,
      likeCount: q.likeCount,
      replyCount: q.replyCount,
      createdAt: q.createdAt,
      author: authorDto(q.authorType, q.authorId, authorMaps),
      viewerHasLiked: likedQuestionIds.has(id),
      replies: (repliesByQuestion.get(id) ?? []).map((r) => replyDto(r, authorMaps)),
    };
  });
}

/**
 * All questions for an event, newest first, each carrying its replies
 * (oldest first) and viewerHasLiked. See hydrateQuestions for the batching
 * guarantees.
 */
export async function listQuestions(eventId: string, actor: SocialActor | null): Promise<any[]> {
  const questions = await EventQuestion.find({ eventId }).sort({ createdAt: -1 }).lean();
  return hydrateQuestions(questions, actor);
}

/**
 * The most recent questions ACROSS ALL events, newest first — powers the
 * TopicsPage's cross-event discussion list (listQuestions is scoped to one
 * event's Q&A thread). Reuses hydrateQuestions for author/reply/like
 * hydration, then batch-loads the (id, name) of every distinct event the
 * page of questions touches in one extra query — never one Event lookup per
 * question.
 */
export async function listRecent(actor: SocialActor | null, limit = 20): Promise<any[]> {
  const questions = await EventQuestion.find({}).sort({ createdAt: -1 }).limit(limit).lean();
  if (questions.length === 0) return [];

  const hydrated = await hydrateQuestions(questions, actor);

  const eventIds = [...new Set(questions.map((q) => String(q.eventId)))];
  const events = await Event.find({ _id: { $in: eventIds } }).select('name').lean();
  const eventMap = new Map(events.map((e: any) => [String(e._id), e]));

  return hydrated.map((q) => ({
    ...q,
    event: { id: q.eventId, name: eventMap.get(q.eventId)?.name ?? null },
  }));
}

/** Post a new question on an event's Q&A thread. */
export async function createQuestion(eventId: string, actor: SocialActor, body: string): Promise<any> {
  await assertActorNotSuspended(actor);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Question body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Question is too long');
  if (!(await Event.exists({ _id: eventId }))) throw new HttpError(404, 'Event not found');

  const question: IEventQuestion = await EventQuestion.create({
    eventId,
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });

  const authorMaps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return {
    id: String(question._id),
    eventId: String(question.eventId),
    body: question.body,
    likeCount: question.likeCount,
    replyCount: question.replyCount,
    createdAt: question.createdAt,
    author: authorDto(actor.type, actor.id, authorMaps),
    viewerHasLiked: false,
    replies: [],
  };
}

/** Post a reply on an existing question, incrementing its replyCount. */
export async function createReply(questionId: string, actor: SocialActor, body: string): Promise<any> {
  await assertActorNotSuspended(actor);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Reply body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Reply is too long');

  const question = await EventQuestion.findById(questionId).select('eventId');
  if (!question) throw new HttpError(404, 'Question not found');

  const reply = await EventQuestionReply.create({
    questionId,
    eventId: question.eventId,
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });
  await EventQuestion.updateOne({ _id: questionId }, { $inc: { replyCount: 1 } });

  const authorMaps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return replyDto(reply, authorMaps);
}

/** Toggle the actor's like on a question. Mirrors toggleEventLike/toggleReaction. */
export async function toggleQuestionLike(questionId: string, actor: SocialActor): Promise<{ active: boolean; likeCount: number }> {
  await assertActorNotSuspended(actor);
  if (!(await EventQuestion.exists({ _id: questionId }))) throw new HttpError(404, 'Question not found');

  const { active } = await toggleReactionGeneric({
    reactionModel: EventQuestionReaction,
    targetModel: EventQuestion,
    targetField: 'questionId',
    targetId: questionId,
    actor,
    type: 'like',
    counterField: 'likeCount',
  });
  const q = await EventQuestion.findById(questionId).select('likeCount').lean();
  return { active, likeCount: q?.likeCount ?? 0 };
}
