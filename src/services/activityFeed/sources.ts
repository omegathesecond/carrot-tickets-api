import { EventReaction } from '@models/eventReaction.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Follow } from '@models/follow.model';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import type { ActivityCandidate } from './types';

export interface SourceOpts {
  before?: Date;
  limit: number;
  actorIds?: string[] | null;
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

export async function likeEventCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({ type: 'like' }, opts);
  if (opts.actorIds) query.buyerId = { $in: opts.actorIds };
  const rows = await EventReaction.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const published = await publishedEventIds(rows.map((r) => r.eventId));
  return rows
    .filter((r) => published.has(String(r.eventId)))
    .map((r) => ({
      type: 'like_event' as const,
      sourceId: String(r._id),
      sortAt: r.createdAt as Date,
      actor: { kind: actorKind(r.actorType), id: String(r.buyerId) },
      target: { kind: 'event' as const, id: String(r.eventId) },
    }));
}

export async function likePostCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({ type: 'like' }, opts);
  if (opts.actorIds) query.buyerId = { $in: opts.actorIds };
  const rows = await UpdateReaction.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  const live = await livePostIds(rows.map((r) => r.updateId));
  return rows
    .filter((r) => live.has(String(r.updateId)))
    .map((r) => ({
      type: 'like_post' as const,
      sourceId: String(r._id),
      sortAt: r.createdAt as Date,
      actor: { kind: actorKind(r.actorType), id: String(r.buyerId) },
      target: { kind: 'post' as const, id: String(r.updateId) },
    }));
}

export async function followCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({}, opts);
  if (opts.actorIds) query.followerId = { $in: opts.actorIds };
  const rows = await Follow.find(query).sort({ createdAt: -1 }).limit(opts.limit).lean();
  return rows.map((r) => ({
    type: 'follow' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: actorKind(r.followerType), id: String(r.followerId) },
    target: { kind: r.targetType === 'organizer' ? ('organizer' as const) : ('buyer' as const), id: String(r.targetId) },
  }));
}

export async function postCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  const query = windowed({ status: 'active', 'media.status': 'ready' }, opts);
  if (opts.actorIds) query.authorId = { $in: opts.actorIds };
  const rows = await Update.find(query).sort({ createdAt: -1 }).limit(opts.limit).select('authorType authorId createdAt').lean();
  return rows.map((r) => ({
    type: 'post' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: actorKind(r.authorType), id: String(r.authorId) },
    target: { kind: 'post' as const, id: String(r._id) },
  }));
}

export async function eventCandidates(opts: SourceOpts): Promise<ActivityCandidate[]> {
  // publishedAt is optional on older rows; createdAt is the fallback, which is
  // why the window predicate is an $or rather than a single field.
  const query: any = { status: EventStatus.PUBLISHED };
  if (opts.before) {
    query.$or = [
      { publishedAt: { $lt: opts.before } },
      { publishedAt: { $exists: false }, createdAt: { $lt: opts.before } },
    ];
  }
  if (opts.actorIds) query.vendorId = { $in: opts.actorIds };
  const rows = await Event.find(query).sort({ publishedAt: -1, createdAt: -1 }).limit(opts.limit)
    .select('vendorId publishedAt createdAt').lean();
  return rows.map((r) => ({
    type: 'event' as const,
    sourceId: String(r._id),
    sortAt: (r.publishedAt ?? r.createdAt) as Date,
    actor: { kind: 'organizer' as const, id: String(r.vendorId) },
    target: { kind: 'event' as const, id: String(r._id) },
  }));
}
