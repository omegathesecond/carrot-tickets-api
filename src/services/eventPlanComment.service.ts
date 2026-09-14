import { EventPlanComment, IEventPlanComment } from '@models/eventPlanComment.model';
import { EventPlanCommentReaction } from '@models/eventPlanCommentReaction.model';
import { EventPlan } from '@models/eventPlan.model';
import { toggleReactionGeneric } from '@services/reactions.service';
import { assertActorNotSuspended, authorDto, loadAuthorMaps, type AuthorMaps } from '@services/socialAuthor.service';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import type { SocialActor } from '@utils/socialActor.util';

const MAX_BODY_LENGTH = 1000;

interface CommentDto {
  id: string;
  planId: string;
  parentId: string | null;
  body: string;
  likeCount: number;
  replyCount: number;
  createdAt: Date;
  author: ReturnType<typeof authorDto>;
  viewerHasLiked: boolean;
  viewerIsAuthor: boolean;
  replies: CommentDto[];
}

function commentDto(
  c: any,
  maps: AuthorMaps,
  viewer: { actor: SocialActor | null; likedIds: Set<string> },
  replies: any[] = []
): CommentDto {
  const id = String(c._id);
  return {
    id,
    planId: String(c.planId),
    parentId: c.parentId ? String(c.parentId) : null,
    body: c.body,
    likeCount: c.likeCount ?? 0,
    replyCount: c.replyCount ?? 0,
    createdAt: c.createdAt,
    author: authorDto(c.authorType, c.authorId, maps),
    viewerHasLiked: viewer.likedIds.has(id),
    viewerIsAuthor: !!viewer.actor && c.authorType === viewer.actor.type && String(c.authorId) === String(viewer.actor.id),
    replies: replies.map((r) => commentDto(r, maps, viewer)),
  };
}

/** Public plans only — comments (like every other social-engagement action
 *  here) never apply to a Private plan, regardless of the viewer's
 *  membership. Mirrors EventPlanService's own private assertPublicActive. */
async function assertPublicActivePlan(planId: string): Promise<void> {
  if (!HEX24.test(planId)) throw new HttpError(400, 'Invalid plan id');
  const plan = await EventPlan.findById(planId).select('visibility status');
  if (!plan) throw new HttpError(404, 'Plan not found');
  if (plan.visibility !== 'public' || plan.status !== 'active') throw new HttpError(403, 'Only public plans support this');
}

/** All active top-level comments + their active replies for one Public Event
 *  Plan, newest-first, hydrated with author/like state. */
export async function listPlanComments(planId: string, actor: SocialActor | null): Promise<any[]> {
  await assertPublicActivePlan(planId);

  const tops = await EventPlanComment.find({ planId, parentId: null, status: 'active' }).sort({ createdAt: -1 }).lean();
  if (tops.length === 0) return [];

  const topIds = tops.map((t: any) => String(t._id));
  const replies = await EventPlanComment.find({ parentId: { $in: topIds }, status: 'active' }).sort({ createdAt: 1 }).lean();

  const authorMaps = await loadAuthorMaps([...tops, ...replies].map((c: any) => ({ authorType: c.authorType, authorId: c.authorId })));

  const allIds = [...topIds, ...replies.map((r: any) => String(r._id))];
  const likedIds = actor
    ? new Set(
        (await EventPlanCommentReaction.find({ commentId: { $in: allIds }, actorType: actor.type, buyerId: actor.id, type: 'like' }).lean()).map(
          (r: any) => String(r.commentId)
        )
      )
    : new Set<string>();

  const repliesByParent = new Map<string, any[]>();
  for (const r of replies) {
    const key = String((r as any).parentId);
    if (!repliesByParent.has(key)) repliesByParent.set(key, []);
    repliesByParent.get(key)!.push(r);
  }

  const viewer = { actor, likedIds };
  return tops.map((t: any) => commentDto(t, authorMaps, viewer, repliesByParent.get(String(t._id)) ?? []));
}

/** Post a top-level comment, or a reply when `parentId` is given (one level
 *  of nesting — matches the Attendance Status discussion's "reply to
 *  comments", not reply-to-reply). */
export async function postPlanComment(planId: string, actor: SocialActor, body: string, parentId?: string): Promise<any> {
  await assertActorNotSuspended(actor);
  await assertPublicActivePlan(planId);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Comment body is required');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Comment is too long');

  let parent: IEventPlanComment | null = null;
  if (parentId) {
    if (!HEX24.test(parentId)) throw new HttpError(400, 'Invalid parent comment id');
    parent = await EventPlanComment.findOne({ _id: parentId, planId, status: 'active' });
    if (!parent) throw new HttpError(404, 'Comment being replied to was not found');
    if (parent.parentId) throw new HttpError(400, 'Cannot reply to a reply');
  }

  const comment = await EventPlanComment.create({
    planId,
    parentId: parent ? parent._id : undefined,
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });
  await EventPlan.updateOne({ _id: planId }, { $inc: { commentCount: 1 } });
  if (parent) await EventPlanComment.updateOne({ _id: parent._id }, { $inc: { replyCount: 1 } });

  const authorMaps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return commentDto(comment, authorMaps, { actor, likedIds: new Set() });
}

/** Toggle the actor's like on a plan comment. */
export async function reactToPlanComment(commentId: string, actor: SocialActor): Promise<{ active: boolean; likeCount: number }> {
  await assertActorNotSuspended(actor);
  if (!HEX24.test(commentId)) throw new HttpError(400, 'Invalid comment id');
  const comment = await EventPlanComment.findOne({ _id: commentId, status: 'active' }).select('planId');
  if (!comment) throw new HttpError(404, 'Comment not found');
  await assertPublicActivePlan(String(comment.planId));

  const { active } = await toggleReactionGeneric({
    reactionModel: EventPlanCommentReaction,
    targetModel: EventPlanComment,
    targetField: 'commentId',
    targetId: commentId,
    actor,
    type: 'like',
    counterField: 'likeCount',
  });
  const c = await EventPlanComment.findById(commentId).select('likeCount').lean();
  return { active, likeCount: (c as any)?.likeCount ?? 0 };
}

/** Delete your own comment (soft-delete, matching VoteComment/UpdateComment) —
 *  decrements the parent plan's commentCount, and the parent comment's
 *  replyCount when this was a reply, so both stay in sync with the visible
 *  thread. */
export async function deleteOwnPlanComment(commentId: string, actor: SocialActor): Promise<void> {
  if (!HEX24.test(commentId)) throw new HttpError(400, 'Invalid comment id');
  const comment = await EventPlanComment.findById(commentId);
  if (!comment || comment.status === 'removed') return; // idempotent
  if (comment.authorType !== actor.type || String(comment.authorId) !== String(actor.id)) {
    throw new HttpError(403, 'Not your comment to delete');
  }
  comment.status = 'removed';
  await comment.save();
  await EventPlan.updateOne({ _id: comment.planId }, { $inc: { commentCount: -1 } });
  if (comment.parentId) await EventPlanComment.updateOne({ _id: comment.parentId }, { $inc: { replyCount: -1 } });
}
