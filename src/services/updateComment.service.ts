import { Update } from '@models/update.model';
import { UpdateComment } from '@models/updateComment.model';
import { assertActorNotSuspended, authorDto, loadAuthorMaps } from '@services/socialAuthor.service';
import { HttpError } from '@utils/httpError.util';
import { isActorAuthorOf, type SocialActor } from '@utils/socialActor.util';

const MAX_BODY_LENGTH = 1000;
const PAGE_SIZE = 30;

export interface CommentDTO {
  id: string;
  updateId: string;
  body: string;
  createdAt: Date;
  author: ReturnType<typeof authorDto>;
  /** May the viewer delete this comment? True for its author, for the author
   *  of the post it sits under, and for a superadmin (the caller ORs that in
   *  — it is a request-level fact this service can't see). */
  viewerCanDelete: boolean;
}

/**
 * The post a comment thread hangs off, in the two fields every path here
 * needs. Loaded once per request rather than re-queried per comment.
 */
async function loadCommentableUpdate(updateId: string) {
  const update = (await Update.findById(updateId)
    .select('_id status authorType authorId commentCount')
    .lean()) as any;
  if (!update || update.status === 'removed') throw new HttpError(404, 'Post not found');
  return update;
}

/**
 * One page of a post's comments, newest first.
 *
 * `actor` is the viewer, used ONLY to compute viewerCanDelete — comments are
 * world-readable (the Discover feed itself is public), so an anonymous read
 * returns the same rows with every viewerCanDelete false.
 */
export async function listComments(
  updateId: string,
  actor: SocialActor | null,
  cursor?: string,
  isSuperAdmin = false,
): Promise<{ items: CommentDTO[]; nextCursor: string | null; commentCount: number }> {
  const update = await loadCommentableUpdate(updateId);

  const filter: any = { updateId, status: 'active' };
  if (cursor) {
    const d = new Date(cursor);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid cursor');
    filter.createdAt = { $lt: d };
  }

  const docs = await UpdateComment.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE + 1).lean();
  const page = docs.slice(0, PAGE_SIZE);
  const nextCursor = docs.length > PAGE_SIZE ? new Date(page[page.length - 1]!.createdAt).toISOString() : null;

  const maps = await loadAuthorMaps(page.map((c) => ({ authorType: c.authorType, authorId: c.authorId })));
  // The post's author may delete anything under their own post; computed once
  // for the page rather than per row.
  const viewerOwnsPost = isActorAuthorOf(update.authorType, update.authorId, actor);

  return {
    items: page.map((c) => ({
      id: String(c._id),
      updateId: String(c.updateId),
      body: c.body,
      createdAt: c.createdAt,
      author: authorDto(c.authorType, c.authorId, maps),
      viewerCanDelete: isSuperAdmin || viewerOwnsPost || isActorAuthorOf(c.authorType, c.authorId, actor),
    })),
    nextCursor,
    commentCount: update.commentCount ?? 0,
  };
}

/**
 * Post a comment, incrementing the parent's commentCount.
 *
 * The counter is written with $inc on the parent rather than recomputed from a
 * count() so a hot post doesn't pay for a scan on every read; remove() is the
 * matching decrement. They must stay paired.
 */
export async function createComment(updateId: string, actor: SocialActor, body: unknown): Promise<CommentDTO> {
  await assertActorNotSuspended(actor);
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'Comment cannot be empty');
  if (trimmed.length > MAX_BODY_LENGTH) throw new HttpError(400, 'Comment is too long');

  const update = await loadCommentableUpdate(updateId);

  const comment = await UpdateComment.create({
    updateId,
    authorType: actor.type,
    authorId: actor.id,
    body: trimmed,
  });
  await Update.updateOne({ _id: updateId }, { $inc: { commentCount: 1 } });

  const maps = await loadAuthorMaps([{ authorType: actor.type, authorId: actor.id }]);
  return {
    id: String(comment._id),
    updateId: String(comment.updateId),
    body: comment.body,
    createdAt: comment.createdAt,
    author: authorDto(actor.type, actor.id, maps),
    // The author of a comment can always delete it, so this is true by
    // construction — no need to consult the post's owner here.
    viewerCanDelete: true,
  };
}

/**
 * Soft-delete a comment: its author, the author of the post it sits under, or
 * a superadmin. Mirrors UpdateController.remove's authorization shape so
 * "who may delete this" reads the same for posts and for comments.
 *
 * Already-removed comments return without touching the counter — a double
 * delete must not decrement twice.
 */
export async function removeComment(
  commentId: string,
  actor: SocialActor | null,
  isSuperAdmin = false,
): Promise<{ ok: true; commentCount: number }> {
  const comment = await UpdateComment.findById(commentId);
  if (!comment) throw new HttpError(404, 'Comment not found');

  const update = await Update.findById(comment.updateId).select('_id authorType authorId commentCount');
  const ownsComment = isActorAuthorOf(comment.authorType, comment.authorId, actor);
  const ownsPost = !!update && isActorAuthorOf(update.authorType, update.authorId, actor);
  if (!isSuperAdmin && !ownsComment && !ownsPost) throw new HttpError(403, 'Not allowed');

  if (comment.status === 'removed') return { ok: true, commentCount: update?.commentCount ?? 0 };

  comment.status = 'removed';
  await comment.save();
  // $max-clamped so a counter that has drifted below zero (or a legacy post
  // whose comments predate the counter) can't go negative and render "-1".
  const after = await Update.findOneAndUpdate(
    { _id: comment.updateId },
    [{ $set: { commentCount: { $max: [0, { $subtract: [{ $ifNull: ['$commentCount', 0] }, 1] }] } } }],
    { new: true, projection: { commentCount: 1 } },
  ).lean();

  return { ok: true, commentCount: (after as any)?.commentCount ?? 0 };
}
