import { Follow } from '@models/follow.model';
import { goingCandidates } from './going';
import { likeEventCandidates, likePostCandidates, followCandidates, postCandidates, eventCandidates } from './sources';
import type { SourceResult } from './sources';
import { hydrate } from './hydrate';
import { SOURCE_KEYS } from './types';
import type { ActivityCandidate, ActivityCursor, ActivityFeedOpts, ActivityItem, ActivityType } from './types';

const MAX_LIMIT = 50;

/** A malformed cursor starts from newest rather than throwing — same
 *  contract as feed.service.ts's decode(). Any individual watermark whose
 *  value isn't a parseable date (e.g. `{"le":"not-a-date"}` — syntactically
 *  valid JSON, but junk) is dropped rather than kept — `new Date('...')`
 *  downstream would otherwise produce an Invalid Date and blow up the
 *  `createdAt: { $lt: Invalid Date }` query with a Mongoose CastError
 *  instead of just starting that one source from newest. */
function decode(cursor?: string): ActivityCursor {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const clean: ActivityCursor = {};
    for (const key of Object.values(SOURCE_KEYS)) {
      const raw = (parsed as Record<string, unknown>)[key];
      if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) {
        (clean as Record<string, string>)[key] = raw;
      }
    }
    return clean;
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
  // socially. `viewer` is REQUIRED for this tab — Mongoose silently strips an
  // `undefined` `followerId` out of a query, which would degrade this into
  // "every follow of this type on the whole platform" and leak a global feed
  // under the following tab's name. Fail loudly instead of guessing.
  let actorIds: string[] | null = null;
  if (opts.tab === 'following') {
    if (!opts.viewer?.id) {
      throw new Error('getActivityFeed: tab "following" requires opts.viewer');
    }
    const follows = await Follow.find({
      followerType: opts.viewer.type === 'vendor' ? 'vendor' : 'buyer',
      followerId: opts.viewer.id,
    }).select('targetId').lean();
    actorIds = follows.map((f) => String(f.targetId));
    if (actorIds.length === 0) return { items: [], nextCursor: null };
  }

  const per = (type: ActivityType) => ({ before: watermark(cursor, type), limit, actorIds });

  const [likeEvents, likePosts, follows, going, posts, events] = await Promise.all([
    likeEventCandidates(per('like_event')),
    likePostCandidates(per('like_post')),
    followCandidates(per('follow')),
    goingCandidates(per('going')),
    postCandidates(per('post')),
    eventCandidates(per('event')),
  ]);

  // All six sources share ONE shape: `{ candidates, nextBefore }`.
  // `nextBefore` is the SCAN floor — how far the underlying query actually
  // looked — not the SURVIVOR floor. `likeEventCandidates` / `likePostCandidates`
  // filter fetched rows by published/live status AFTER the DB `.limit()`, so
  // a full fetch that gets filtered down to zero candidates must still
  // report its scan depth, or this merge can't tell "this source is
  // drained" apart from "this source scanned N rows and kept none of them"
  // — the latter can have plenty of real, valid rows waiting just below the
  // floor that a naive `rows.length < limit` check would abandon forever.
  const results: Record<ActivityType, SourceResult> = {
    like_event: likeEvents,
    like_post: likePosts,
    follow: follows,
    going,
    post: posts,
    event: events,
  };

  const all: ActivityCandidate[] = Object.values(results)
    .flatMap((r) => r.candidates)
    .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());

  const page = all.slice(0, limit);
  const items = await hydrate(page);

  // The next cursor records the last consumed position PER SOURCE, with one
  // rule applied uniformly to all six (this generalises what `going` already
  // did — see going.ts's own doc comment for why it needs a floor at all):
  //   1. If the page consumed at least one candidate from a source, its key
  //      becomes that consumed row's (oldest, since `page` is newest-first)
  //      sortAt.
  //   2. Else, if that source published a non-null `nextBefore`, its key
  //      advances TO `nextBefore` anyway — this is what un-wedges a source
  //      that scanned a full window but kept nothing from it (filtered-to-
  //      empty, e.g. `likeEventCandidates` on a page where an organizer
  //      unpublished the newest-liked event) or resolved nothing (going's
  //      boundary clamp): without this, a zero-candidate page would re-issue
  //      the identical query forever.
  //   3. A key must never advance PAST (older than) its own `nextBefore` —
  //      for the five simple sources a consumed row is always at or after
  //      the scan floor by construction, so this degenerates to a no-op;
  //      for `going` it is load-bearing (a twin row's dedupe winner can sit
  //      below the boundary of the OTHER sub-collection's window).
  //   4. Otherwise (nothing consumed, no floor published) the source's key
  //      is left untouched — it either wasn't queried deep enough to matter
  //      this page, or it is genuinely exhausted; re-querying its unchanged
  //      watermark is harmless.
  const next: ActivityCursor = { ...cursor };
  let advanced = false;
  for (const type of Object.keys(SOURCE_KEYS) as ActivityType[]) {
    const floor = results[type].nextBefore;

    // Oldest candidate of this type actually consumed into `page`. `page` is
    // globally sorted newest-first and each source's own candidates were
    // already sorted newest-first before the merge, so the LAST match in
    // iteration order is the oldest consumed row of that type.
    let consumed: Date | undefined;
    for (const c of page) {
      if (c.type === type) consumed = c.sortAt;
    }

    if (consumed && (!floor || consumed.getTime() >= floor.getTime())) {
      next[SOURCE_KEYS[type]] = consumed.toISOString();
      advanced = true;
    } else if (floor) {
      next[SOURCE_KEYS[type]] = floor.toISOString();
      advanced = true;
    }
  }

  // Exhausted when every source has genuinely scanned to its own end (no
  // source published a floor — a published floor means rows were
  // deliberately withheld, filtered-away or not, so there IS more to look
  // at) AND this page's merge didn't have to leave anything behind.
  const exhausted = all.length <= limit && Object.values(results).every((r) => r.nextBefore === null);

  return { items, nextCursor: exhausted || !advanced ? null : encode(next) };
}
