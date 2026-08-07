import { isValidObjectId } from 'mongoose';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import type { ActivityCandidate, ActivityItem, ActivityActor, ActivityTarget } from './types';

/** A source contract violation (e.g. a candidate id derived from an
 *  optional/missing field upstream) must never 500 the whole page — one
 *  malformed id is dropped here, defence-in-depth on top of each source
 *  being responsible for not emitting one in the first place. The row it
 *  belongs to then resolves to nothing via the normal buildActor/buildTarget
 *  "not found" path below, which is the correct, honest outcome. */
function onlyValidIds(ids: Iterable<string>): string[] {
  return [...ids].filter((id) => isValidObjectId(id));
}

/** Mirrors landing/src/lib/eventUrl.ts slugifyEventName. Keep in sync — the
 *  client resolves an event by the trailing 24-hex id, so a drifting slug is
 *  cosmetic, not fatal. */
function slugifyEventName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function hydrate(candidates: ActivityCandidate[]): Promise<ActivityItem[]> {
  if (candidates.length === 0) return [];

  const buyerIds = new Set<string>();
  const vendorIds = new Set<string>();
  const eventIds = new Set<string>();
  const postIds = new Set<string>();
  for (const c of candidates) {
    (c.actor.kind === 'buyer' ? buyerIds : vendorIds).add(c.actor.id);
    if (!c.target) continue; // join rows are actor-only
    if (c.target.kind === 'buyer') buyerIds.add(c.target.id);
    if (c.target.kind === 'organizer') vendorIds.add(c.target.id);
    if (c.target.kind === 'event') eventIds.add(c.target.id);
    if (c.target.kind === 'post') postIds.add(c.target.id);
  }

  // Suspended actors are excluded HERE, once, for all seven sources. A suspended
  // buyer can still be a follow TARGET (they are not erased), but never an actor.
  const validBuyerIds = onlyValidIds(buyerIds);
  const validVendorIds = onlyValidIds(vendorIds);
  const validEventIds = onlyValidIds(eventIds);
  const validPostIds = onlyValidIds(postIds);

  const [buyers, vendors, events, posts] = await Promise.all([
    validBuyerIds.length ? Buyer.find({ _id: { $in: validBuyerIds } }).select('name username avatarUrl socialSuspendedAt').lean() : [],
    validVendorIds.length ? Vendor.find({ _id: { $in: validVendorIds } }).select('businessName slug logoUrl').lean() : [],
    validEventIds.length ? Event.find({ _id: { $in: validEventIds } }).select('name posterUrl').lean() : [],
    validPostIds.length ? Update.find({ _id: { $in: validPostIds } }).select('media').lean() : [],
  ]);

  const buyerById = new Map(buyers.map((b) => [String(b._id), b]));
  const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
  const eventById = new Map(events.map((e) => [String(e._id), e]));
  const postById = new Map(posts.map((p) => [String(p._id), p]));

  const buildActor = (ref: ActivityCandidate['actor']): ActivityActor | null => {
    if (ref.kind === 'buyer') {
      const b = buyerById.get(ref.id);
      if (!b || b.socialSuspendedAt) return null;
      return {
        kind: 'buyer', id: ref.id,
        name: b.name ?? null,
        username: b.username ?? null,
        avatarUrl: b.avatarUrl ?? null,
        href: b.username ? `/u/${b.username}` : `/u/${ref.id}`,
      };
    }
    const v = vendorById.get(ref.id);
    if (!v) return null;
    return {
      kind: 'organizer', id: ref.id,
      name: v.businessName ?? null,
      username: v.slug ?? null,
      avatarUrl: v.logoUrl ?? null,
      href: `/o/${ref.id}`,
    };
  };

  const buildTarget = (ref: NonNullable<ActivityCandidate['target']>): ActivityTarget | null => {
    switch (ref.kind) {
      case 'event': {
        const e = eventById.get(ref.id);
        if (!e) return null;
        return {
          kind: 'event', id: ref.id, name: e.name ?? null,
          imageUrl: (e as any).posterUrl ?? null,
          href: `/event/${slugifyEventName(e.name ?? '')}-${ref.id}`,
        };
      }
      case 'post': {
        const p = postById.get(ref.id);
        if (!p) return null;
        const media: any = (p as any).media ?? {};
        // image.url for photo posts; video.poster (the model's field name —
        // NOT thumbnailUrl) for video posts.
        return {
          kind: 'post', id: ref.id, name: null,
          imageUrl: media.image?.url ?? media.video?.poster ?? null,
          href: `/post/${ref.id}`,
        };
      }
      case 'buyer': {
        const b = buyerById.get(ref.id);
        if (!b) return null;
        return {
          kind: 'buyer', id: ref.id, name: b.name ?? b.username ?? null,
          imageUrl: b.avatarUrl ?? null,
          href: b.username ? `/u/${b.username}` : `/u/${ref.id}`,
        };
      }
      case 'organizer': {
        const v = vendorById.get(ref.id);
        if (!v) return null;
        return { kind: 'organizer', id: ref.id, name: v.businessName ?? null, imageUrl: v.logoUrl ?? null, href: `/o/${ref.id}` };
      }
    }
  };

  const items: ActivityItem[] = [];
  for (const c of candidates) {
    const actor = buildActor(c.actor);
    if (!actor) continue;
    // A candidate MAY legitimately have no target (a join is actor-only). Only
    // drop the row when a target IS expected but fails to resolve.
    let target: ActivityTarget | null = null;
    if (c.target) {
      target = buildTarget(c.target);
      if (!target) continue;
    }
    items.push({ type: c.type, id: `${c.type}:${c.sourceId}`, sortAt: c.sortAt.toISOString(), actor, target });
  }
  return items;
}
