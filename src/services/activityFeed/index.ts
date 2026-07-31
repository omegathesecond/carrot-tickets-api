import { Follow } from '@models/follow.model';
import { goingCandidates } from './going';
import { likeEventCandidates, likePostCandidates, followCandidates, postCandidates, eventCandidates } from './sources';
import { hydrate } from './hydrate';
import { SOURCE_KEYS } from './types';
import type { ActivityCandidate, ActivityCursor, ActivityFeedOpts, ActivityItem, ActivityType } from './types';

const MAX_LIMIT = 50;

/** A malformed cursor starts from newest rather than throwing — same
 *  contract as feed.service.ts's decode(). */
function decode(cursor?: string): ActivityCursor {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function encode(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

const watermark = (cursor: ActivityCursor, type: ActivityType): Date | undefined => {
  const raw = cursor[SOURCE_KEYS[type]];
  return raw ? new Date(raw) : undefined;
};

/**
 * The activity feed: six sources merged newest-first, with one cursor
 * watermark per source so heterogeneous collections page without an offset.
 *
 * There is NO time cutoff — paging continues until every source is exhausted,
 * so the feed reads full on a quiet day without any fabricated rows.
 */
export async function getActivityFeed(
  opts: ActivityFeedOpts
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), MAX_LIMIT);
  const cursor = decode(opts.cursor);

  // Following: the viewer's followed buyers AND organizers, both of which act
  // socially. Callers guarantee `viewer` is present for this tab.
  let actorIds: string[] | null = null;
  if (opts.tab === 'following') {
    const follows = await Follow.find({
      followerType: opts.viewer?.type === 'vendor' ? 'vendor' : 'buyer',
      followerId: opts.viewer?.id,
    }).select('targetId').lean();
    actorIds = follows.map((f) => String(f.targetId));
    if (actorIds.length === 0) return { items: [], nextCursor: null };
  }

  const per = (type: ActivityType) => ({ before: watermark(cursor, type), limit, actorIds });

  const [likeEvents, likePosts, follows, goingResult, posts, events] = await Promise.all([
    likeEventCandidates(per('like_event')),
    likePostCandidates(per('like_post')),
    followCandidates(per('follow')),
    goingCandidates(per('going')),
    postCandidates(per('post')),
    eventCandidates(per('event')),
  ]);

  // `going` is the only source that merges TWO collections (Membership and
  // Ticket) under one watermark. Their sub-windows are limited independently,
  // so it publishes `nextBefore`: the floor below which THIS call could not
  // guarantee completeness. Two rules follow, and both are load-bearing:
  //   1. `g` must never advance PAST nextBefore, or a pair whose twin row sat
  //      below the shallower sub-window is skipped on every subsequent page.
  //   2. When no going candidate is consumed, `g` must advance TO nextBefore
  //      anyway — otherwise a clamped-to-empty page re-issues the identical
  //      query forever and the source wedges permanently.
  const going = goingResult.candidates;
  const goingFloor = goingResult.nextBefore;

  const all: ActivityCandidate[] = [...likeEvents, ...likePosts, ...follows, ...going, ...posts, ...events]
    .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());

  const page = all.slice(0, limit);
  const items = await hydrate(page);

  // The next cursor records the last consumed position PER SOURCE. A source
  // with nothing consumed on this page keeps its previous watermark, so it is
  // not re-read from the top on the next page.
  const next: ActivityCursor = { ...cursor };
  let advanced = false;
  for (const candidate of page) {
    next[SOURCE_KEYS[candidate.type]] = candidate.sortAt.toISOString();
    advanced = true;
  }

  // Apply going's two rules (see the comment above goingFloor).
  if (goingFloor) {
    const floorIso = goingFloor.toISOString();
    const consumed = next[SOURCE_KEYS.going];
    // Rule 1 + 2 collapse to: take whichever is NEWER — the floor, or the last
    // consumed going row. `undefined` (nothing consumed) falls through to the
    // floor, which is what un-wedges a clamped-to-empty page.
    if (!consumed || Date.parse(consumed) < goingFloor.getTime()) {
      next[SOURCE_KEYS.going] = floorIso;
    }
    advanced = true; // a published floor is real progress even with zero rows
  }

  // Exhausted when every source returned less than a full window AND the page
  // consumed everything they gave us — there is nothing left behind. `going`
  // additionally must have published no floor: a non-null floor means it
  // deliberately withheld rows below it, so there IS more to come.
  const exhausted = all.length <= limit
    && !goingFloor
    && [likeEvents, likePosts, follows, going, posts, events].every((rows) => rows.length < limit);

  return { items, nextCursor: exhausted || !advanced ? null : encode(next) };
}
