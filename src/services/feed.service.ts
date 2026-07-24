import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { notEndedFilter } from '@utils/eventVisibility.util';
import { PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import type { SocialActor } from '@utils/socialActor.util';

export type FeedSlide =
  | { type: 'update'; id: string; sortAt: string; [k: string]: any }
  | { type: 'event'; id: string; sortAt: string; [k: string]: any }
  | { type: 'activity'; id: string; sortAt: string; [k: string]: any };

interface FeedOpts { tab: 'for-you' | 'following' | 'events'; cursor?: string; actor?: SocialActor; limit?: number; }
interface Cursor { u?: string; e?: number; a?: string; }

function decode(cursor?: string): Cursor { if (!cursor) return {}; try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return {}; } }
function encode(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString('base64url'); }

// per-window slot pattern (8): u u u e u u a e
const PATTERN: Array<'u' | 'e' | 'a'> = ['u', 'u', 'u', 'e', 'u', 'u', 'a', 'e'];

export async function getFeed(opts: FeedOpts): Promise<{ items: FeedSlide[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 12, 30);
  const cur = decode(opts.cursor);
  const wantActivity = opts.tab === 'for-you';

  // resolve follow sets for personalization/following
  let followedAuthorIds: any[] = [];
  let followedOrgIds: any[] = [];
  if (opts.actor && opts.tab === 'following') {
    const follows = await Follow.find({ followerType: opts.actor.type === 'vendor' ? 'vendor' : 'buyer', followerId: opts.actor.id }).lean();
    followedAuthorIds = follows.filter((f) => f.targetType === 'buyer').map((f) => f.targetId);
    followedOrgIds = follows.filter((f) => f.targetType === 'organizer').map((f) => f.targetId);
  }

  // ---- fetch each source (over-fetch `limit`) ----
  const updateQuery: any = { status: 'active', 'media.status': 'ready' };
  if (opts.tab === 'following') updateQuery.authorId = { $in: [...followedAuthorIds, ...followedOrgIds] };
  if (cur.u) updateQuery.createdAt = { $lt: new Date(cur.u) };
  const updates = opts.tab === 'events' ? [] : await Update.find(updateQuery).sort({ createdAt: -1 }).limit(limit).lean();

  const eventQuery: any = { status: EventStatus.PUBLISHED, ...notEndedFilter() };
  if (opts.tab === 'following') eventQuery.vendorId = { $in: followedOrgIds };
  const eventSkip = cur.e ?? 0;
  const events = await Event.find(eventQuery).sort({ eventDate: 1 }).skip(eventSkip).limit(limit).lean();

  let activity: any[] = [];
  if (wantActivity) {
    const aq: any = { paymentStatus: PaymentStatus.COMPLETED, channel: { $ne: SalesChannel.WRISTBAND } };
    if (cur.a) aq.soldAt = { $lt: new Date(cur.a) };
    activity = await TicketSale.find(aq).sort({ soldAt: -1 }).limit(limit).lean();
  }

  // ---- shape slides ----
  const vendorIds = [
    ...events.map((e) => e.vendorId),
    ...updates.filter((u) => u.authorType === 'vendor').map((u) => u.authorId),
  ];
  const vendors = await Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl').lean();
  const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));
  const buyerIds = updates.filter((u) => u.authorType === 'buyer').map((u) => u.authorId);
  const buyers = await Buyer.find({ _id: { $in: buyerIds } }).select('username name avatarUrl').lean();
  const buyerMap = new Map(buyers.map((b) => [String(b._id), b]));

  const updateSlides: FeedSlide[] = updates.map((u) => ({
    type: 'update', id: String(u._id), sortAt: u.createdAt.toISOString(),
    kind: u.kind, caption: u.caption, media: u.media,
    likeCount: u.likeCount, saveCount: u.saveCount, shareCount: u.shareCount, viewCount: u.viewCount ?? 0,
    eventId: u.eventId ? String(u.eventId) : null,
    author: u.authorType === 'vendor'
      ? { type: 'organizer', id: String(u.authorId), name: vendorMap.get(String(u.authorId))?.businessName ?? 'Organizer', avatarUrl: vendorMap.get(String(u.authorId))?.logoUrl ?? null, slug: vendorMap.get(String(u.authorId))?.slug }
      : { type: 'buyer', id: String(u.authorId), name: buyerMap.get(String(u.authorId))?.name ?? null, username: buyerMap.get(String(u.authorId))?.username ?? null, avatarUrl: buyerMap.get(String(u.authorId))?.avatarUrl ?? null },
  }));

  const eventSlides: FeedSlide[] = events.map((e) => {
    const prices = (e.ticketTypes ?? []).map((t: any) => t.price);
    const org = vendorMap.get(String(e.vendorId));
    return {
      type: 'event', id: String(e._id), sortAt: new Date(e.eventDate).toISOString(),
      name: e.name, venue: e.venue, eventDate: e.eventDate, posterUrl: e.posterUrl ?? null,
      likeCount: e.likeCount ?? 0,
      priceRange: { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 0 },
      // Legacy events predating these fields have neither, so fall back to
      // carrot/null rather than surfacing undefined — same convention as
      // toPublicEventCard (src/utils/eventCard.util.ts).
      ticketing: (e as any).ticketing ?? 'carrot',
      externalTicketUrl: (e as any).externalTicketUrl ?? null,
      organizer: org ? { id: String(e.vendorId), businessName: org.businessName, logoUrl: org.logoUrl ?? null, slug: org.slug } : null,
    };
  });

  const activityEventIds = activity.map((s) => s.eventId);
  const publishedActivityEvents = wantActivity && activityEventIds.length
    ? await Event.find({ _id: { $in: activityEventIds }, status: EventStatus.PUBLISHED }).select('name').lean()
    : [];
  const publishedActivityEventMap = new Map(publishedActivityEvents.map((e) => [String(e._id), e]));

  const activitySlides: FeedSlide[] = activity
    .filter((s) => publishedActivityEventMap.has(String(s.eventId)))
    .map((s) => ({
      type: 'activity', id: String(s._id), sortAt: new Date(s.soldAt).toISOString(),
      quantity: s.quantity, eventId: String(s.eventId), eventName: publishedActivityEventMap.get(String(s.eventId))!.name,
    }));

  // ---- interleave by PATTERN, dropping dry slots ----
  const q = { u: updateSlides, e: eventSlides, a: activitySlides };
  const items: FeedSlide[] = [];
  let pi = 0;
  while (items.length < limit && (q.u.length || q.e.length || (wantActivity && q.a.length))) {
    const slot = PATTERN[pi % PATTERN.length] as 'u' | 'e' | 'a';
    pi++;
    const bucket = q[slot];
    if (bucket.length) { items.push(bucket.shift()!); continue; }
    // slot dry: fall back to whichever has items (u > e > a), else break out of this pass
    const fallback = q.u.length ? q.u : q.e.length ? q.e : (wantActivity && q.a.length ? q.a : null);
    if (!fallback) break;
    items.push(fallback.shift()!);
  }

  // ---- next cursor from the last consumed position of each source ----
  const consumedUpdateAt = items.filter((i) => i.type === 'update').slice(-1)[0]?.sortAt;
  const consumedActivityAt = items.filter((i) => i.type === 'activity').slice(-1)[0]?.sortAt;
  const consumedEventCount = items.filter((i) => i.type === 'event').length;

  const next: Cursor = {};
  if (consumedUpdateAt) next.u = consumedUpdateAt;
  else if (cur.u) next.u = cur.u;
  if (consumedEventCount) next.e = eventSkip + consumedEventCount;
  else if (cur.e) next.e = cur.e;
  if (consumedActivityAt) next.a = consumedActivityAt;
  else if (cur.a) next.a = cur.a;

  const anyMore = items.length >= limit; // conservative: only advertise more if we filled a page
  return { items, nextCursor: anyMore ? encode(next) : null };
}
