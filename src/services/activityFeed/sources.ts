import { Types } from 'mongoose';
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
  // publishedAt is optional on older rows (and may even be explicitly stored
  // as null). An aggregation computes the effective timestamp ONCE, in an
  // `activityAt` field, and reuses it for the window predicate, the sort,
  // AND the emitted sortAt — so the three can never disagree the way a
  // separate find() sort + $or window + `publishedAt ?? createdAt` mapping
  // could (MongoDB sorts a missing/null field as below every Date, which
  // silently demoted recent no-publishedAt rows and could drop them past a
  // `before` cursor forever). `find()` does not offer a computed sort key,
  // hence the aggregation.
  const match: any = { status: EventStatus.PUBLISHED };
  // find() auto-casts query values against the schema; aggregation $match
  // does not, so actorIds strings must be cast to ObjectIds explicitly or
  // vendorId: { $in: [...] } silently matches nothing.
  if (opts.actorIds) match.vendorId = { $in: opts.actorIds.map((id) => new Types.ObjectId(id)) };

  const pipeline: any[] = [
    { $match: match },
    { $addFields: { activityAt: { $ifNull: ['$publishedAt', '$createdAt'] } } },
  ];
  if (opts.before) pipeline.push({ $match: { activityAt: { $lt: opts.before } } });
  pipeline.push(
    { $sort: { activityAt: -1 } },
    { $limit: opts.limit },
    { $project: { vendorId: 1, activityAt: 1 } }
  );

  const rows = await Event.aggregate(pipeline);
  return rows.map((r) => ({
    type: 'event' as const,
    sourceId: String(r._id),
    sortAt: r.activityAt as Date,
    actor: { kind: 'organizer' as const, id: String(r.vendorId) },
    target: { kind: 'event' as const, id: String(r._id) },
  }));
}
