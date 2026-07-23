import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { toPublicEventCard } from '@/utils/eventCard.util';
import { getViewerEventReactions } from '@services/eventReaction.service';
import type { SocialActor } from '@/utils/socialActor.util';

/** Load events by id (preserving the given order) and serialize each to the
 *  public event-card DTO with organizer + per-viewer like flag. */
export async function buildEventCards(eventIds: string[], actor: SocialActor | null): Promise<any[]> {
  if (eventIds.length === 0) return [];
  const events = await Event.find({ _id: { $in: eventIds } });
  const byId = new Map(events.map((e) => [String(e._id), e]));
  const ordered = eventIds.map((id) => byId.get(id)).filter(Boolean) as any[];

  const vendorIds = [...new Set(ordered.map((e) => String(e.vendorId)).filter(Boolean))];
  const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds }, isActive: true }).select('businessName logoUrl') : [];
  const vMap = new Map(vendors.map((v: any) => [String(v._id), { id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null }]));

  const liked = actor ? await getViewerEventReactions(ordered.map((e) => String(e._id)), actor) : {};
  return ordered.map((e) => toPublicEventCard(e, {
    organizer: e.vendorId ? (vMap.get(String(e.vendorId)) ?? null) : null,
    // `?? 0`: events predating the counter have no stored field. Restores
    // parity with the public list card (public.controller.ts), which always
    // emits likeCount.
    likeCount: (e as any).likeCount ?? 0,
    viewerHasLiked: liked[String(e._id)]?.liked ?? false,
  }));
}
