import { Types } from 'mongoose';
import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Follow } from '@models/follow.model';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from './types';

export interface SourceOpts {
  before?: Date;
  limit: number;
  actorIds?: string[] | null;
}

/** Uniform per-source result shape (matches goingCandidates). `nextBefore` is
 *  the scan floor — the oldest `createdAt`/`activityAt` among the rows the DB
 *  actually RETURNED, before any post-fetch filter is applied — published
 *  whenever that fetch came back full (`fetched.length === limit`), i.e.
 *  older rows of THIS source may exist past it that weren't even scanned.
 *  `null` means the scan reached genuinely to the end: nothing left below
 *  `before` for this source, filtered or not. */
export interface SourceResult {
  candidates: ActivityCandidate[];
  nextBefore: Date | null;
}

/** An actorType of 'vendor' means an organizer brand acting socially. */
const actorKind = (actorType: string): 'buyer' | 'organizer' =>
  actorType === 'vendor' ? 'organizer' : 'buyer';

/**
 * Ids of events that are PUBLISHED, among the given candidates.
 *
 * Ended events are deliberately included — this is history, not discovery, so
 * notEndedFilter must NOT be used. Filtering ended events here would empty the
 * feed as soon as a reader pages past the current season.
 */
async function publishedEventIds(ids: any[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await Event.find({ _id: { $in: ids }, status: EventStatus.PUBLISHED }).select('_id').lean();
  return new Set(docs.map((e) => String(e._id)));
}

/** Ids of posts that are still visible, among the given candidates. */
async function livePostIds(ids: any[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const docs = await Update.find({ _id: { $in: ids }, status: 'active', 'media.status': 'ready' }).select('_id').lean();
  return new Set(docs.map((u) => String(u._id)));
}

function windowed(base: any, opts: SourceOpts): any {
  const query = { ...base };
  if (opts.before) query.createdAt = { $lt: opts.before };
  return query;
}

/** The scan floor for a fetch sorted newest-first: the oldest FETCHED row's
 *  timestamp, but only when the fetch came back full — a short fetch already
 *  reached the true end, so there is no floor to publish. This is SCAN depth
 *  (what the DB query returned), not survivor depth (what remains after a
 *  post-fetch filter like "published" or "live") — a source that fetches a
 *  full window and then filters every row to zero must still report how far
 *  it looked, or the caller can't tell "nothing survived" apart from "nothing
 *  exists," and would wrongly declare itself exhausted while unfiltered rows
 *  sit just below the floor. */
function scanFloor<T>(fetched: T[], limit: number, at: (row: T) => Date): Date | null {
  return limit > 0 && fetched.length === limit ? at(fetched[fetched.length - 1]!) : null;
}

export async function likeEventCandidates(opts: SourceOpts): Promise<SourceResult> {
  const query = windowed({ type: 'like' }, opts);
  if (opts.actorIds) query.buyerId = { $in: opts.actorIds };
  const rows = await EventReaction.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.createdAt as Date);
  const published = await publishedEventIds(rows.map((r) => r.eventId));
  const candidates = rows
    .filter((r) => published.has(String(r.eventId)))
    .map((r) => ({
      type: 'like_event' as const,
      sourceId: String(r._id),
      sortAt: r.createdAt as Date,
      actor: { kind: actorKind(r.actorType), id: String(r.buyerId) },
      target: { kind: 'event' as const, id: String(r.eventId) },
    }));
  return { candidates, nextBefore };
}

export async function likePostCandidates(opts: SourceOpts): Promise<SourceResult> {
  const query = windowed({ type: 'like' }, opts);
  if (opts.actorIds) query.buyerId = { $in: opts.actorIds };
  const rows = await UpdateReaction.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.createdAt as Date);
  const live = await livePostIds(rows.map((r) => r.updateId));
  const candidates = rows
    .filter((r) => live.has(String(r.updateId)))
    .map((r) => ({
      type: 'like_post' as const,
      sourceId: String(r._id),
      sortAt: r.createdAt as Date,
      actor: { kind: actorKind(r.actorType), id: String(r.buyerId) },
      target: { kind: 'post' as const, id: String(r.updateId) },
    }));
  return { candidates, nextBefore };
}

export async function followCandidates(opts: SourceOpts): Promise<SourceResult> {
  const query = windowed({}, opts);
  if (opts.actorIds) query.followerId = { $in: opts.actorIds };
  const rows = await Follow.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.createdAt as Date);
  const candidates = rows.map((r) => ({
    type: 'follow' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: actorKind(r.followerType), id: String(r.followerId) },
    target: { kind: r.targetType === 'organizer' ? ('organizer' as const) : ('buyer' as const), id: String(r.targetId) },
  }));
  return { candidates, nextBefore };
}

export async function postCandidates(opts: SourceOpts): Promise<SourceResult> {
  const query = windowed({ status: 'active', 'media.status': 'ready' }, opts);
  if (opts.actorIds) query.authorId = { $in: opts.actorIds };
  const rows = await Update.find(query).sort({ createdAt: -1 }).limit(opts.limit).select('authorType authorId createdAt').lean();
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.createdAt as Date);
  const candidates = rows.map((r) => ({
    type: 'post' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: actorKind(r.authorType), id: String(r.authorId) },
    target: { kind: 'post' as const, id: String(r._id) },
  }));
  return { candidates, nextBefore };
}

export async function eventCandidates(opts: SourceOpts): Promise<SourceResult> {
  // publishedAt is optional on older rows (and may even be explicitly stored
  // as null). An aggregation computes the effective timestamp ONCE, in an
  // `activityAt` field, and reuses it for the window predicate, the sort,
  // AND the emitted sortAt — so the three can never disagree the way a
  // separate find() sort + $or window + `publishedAt ?? createdAt` mapping
  // could (MongoDB sorts a missing/null field as below every Date, which
  // silently demoted recent no-publishedAt rows and could drop them past a
  // `before` cursor forever). `find()` does not offer a computed sort key,
  // hence the aggregation.
  // An event's announcer is whichever of the two mutually-exclusive author
  // fields the schema actually set: `vendorId` for an organizer-created
  // event, `submittedByBuyerId` for a buyer self-listed (community) one —
  // exactly one is always present (see event.model.ts's conditional
  // `required`). A row with NEITHER has no one to attribute the
  // announcement to, and inventing an actor is forbidden, so that (and only
  // that) case is excluded here, in the $match, so it never consumes a page
  // slot.
  const match: any = {
    status: EventStatus.PUBLISHED,
    $or: [{ vendorId: { $exists: true, $ne: null } }, { submittedByBuyerId: { $exists: true, $ne: null } }],
  };
  // find() auto-casts query values against the schema; aggregation $match
  // does not, so actorIds strings must be cast to ObjectIds explicitly or
  // an $in: [...] silently matches nothing. A followed actor may be an
  // organizer (vendorId) OR a buyer who self-listed (submittedByBuyerId) —
  // match against either field, replacing (not adding to) the existence
  // check above, since $in against real ObjectIds already implies presence.
  if (opts.actorIds) {
    const ids = opts.actorIds.map((id) => new Types.ObjectId(id));
    match.$or = [{ vendorId: { $in: ids } }, { submittedByBuyerId: { $in: ids } }];
  }

  const pipeline: any[] = [
    { $match: match },
    { $addFields: { activityAt: { $ifNull: ['$publishedAt', '$createdAt'] } } },
  ];
  if (opts.before) pipeline.push({ $match: { activityAt: { $lt: opts.before } } });
  pipeline.push(
    { $sort: { activityAt: -1 } },
    { $limit: opts.limit },
    { $project: { vendorId: 1, submittedByBuyerId: 1, activityAt: 1 } }
  );

  const rows = await Event.aggregate(pipeline);
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.activityAt as Date);
  const candidates = rows
    .map((r) => {
      // Exactly one of these should be set given the $match above; this is
      // a defensive re-check, not a second filter — never invent an actor
      // if somehow neither is present.
      const actor = r.vendorId
        ? { kind: 'organizer' as const, id: String(r.vendorId) }
        : r.submittedByBuyerId
        ? { kind: 'buyer' as const, id: String(r.submittedByBuyerId) }
        : null;
      if (!actor) return null;
      return {
        type: 'event' as const,
        sourceId: String(r._id),
        sortAt: r.activityAt as Date,
        actor,
        target: { kind: 'event' as const, id: String(r._id) },
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  return { candidates, nextBefore };
}

export async function joinCandidates(opts: SourceOpts): Promise<SourceResult> {
  // A join has no follow relationship, so it belongs only to the "everyone"
  // tab. On the "following" tab (actorIds set) this source is simply empty.
  if (opts.actorIds) return { candidates: [], nextBefore: null };

  const rows = await Buyer.find(windowed({}, opts))
    .sort({ createdAt: -1 })
    .limit(opts.limit)
    .select('createdAt')
    .lean();
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.createdAt as Date);
  const candidates = rows.map((r) => ({
    type: 'join' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: 'buyer' as const, id: String(r._id) },
    // no target — a join is actor-only
  }));
  return { candidates, nextBefore };
}
