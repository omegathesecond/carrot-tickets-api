import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { toPublicEventCard } from '@/utils/eventCard.util';
import { getViewerEventReactions } from '@services/eventReaction.service';
import type { SocialActor } from '@/utils/socialActor.util';

/** Load events by id (preserving the given order) and serialize each to the
 *  public event-card DTO with organizer + per-viewer like flag.
 *
 *  `opts.goingEventIds` adds the viewer's attendance mark. Passed in rather
 *  than resolved here because "going" needs the buyer document (memberships +
 *  ticket phone), which most callers already hold — and callers that don't
 *  care shouldn't pay for the lookup. */
export async function buildEventCards(
  eventIds: string[],
  actor: SocialActor | null,
  opts: { goingEventIds?: Set<string> } = {},
): Promise<any[]> {
  if (eventIds.length === 0) return [];
  const events = await Event.find({ _id: { $in: eventIds } });
  const byId = new Map(events.map((e) => [String(e._id), e]));
  const ordered = eventIds.map((id) => byId.get(id)).filter(Boolean) as any[];

  // Filter BEFORE stringifying: String(undefined) is the truthy string
  // "undefined", which survives .filter(Boolean) and makes Mongoose throw a
  // CastError on the $in below. Reachable since buyer self-listed events —
  // which have no vendor — became publishable.
  const vendorIds = [...new Set(ordered.filter((e) => e.vendorId).map((e) => String(e.vendorId)))];
  const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds }, isActive: true }).select('businessName logoUrl') : [];
  const vMap = new Map(vendors.map((v: any) => [String(v._id), { id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null }]));

  const reactions = actor ? await getViewerEventReactions(ordered.map((e) => String(e._id)), actor) : {};
  return ordered.map((e) => toPublicEventCard(e, {
    ...(opts.goingEventIds ? { viewerIsGoing: opts.goingEventIds.has(String(e._id)) } : {}),
    organizer: e.vendorId ? (vMap.get(String(e.vendorId)) ?? null) : null,
    // `?? 0`: events predating the counter have no stored field. Restores
    // parity with the public list card (public.controller.ts), which always
    // emits likeCount.
    likeCount: (e as any).likeCount ?? 0,
    viewerHasLiked: reactions[String(e._id)]?.liked ?? false,
    viewerHasSaved: reactions[String(e._id)]?.saved ?? false,
  }));
}
