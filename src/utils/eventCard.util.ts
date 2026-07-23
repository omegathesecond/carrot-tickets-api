export interface PublicEventCardExtras {
  recentSales?: number;
  trending?: boolean;
  viewerHasLiked?: boolean;
  likeCount?: number;
  organizer?: { id: string; businessName: string; logoUrl: string | null } | null;
}

/** THE public "event card" DTO. Base fields are always emitted; the optional
 *  extras are emitted ONLY when the caller passes the key, so each existing
 *  call site reproduces its exact prior response shape (no silent widening). */
export function toPublicEventCard(event: any, extras: PublicEventCardExtras = {}) {
  const tts: any[] = event.ticketTypes ?? [];
  const card: Record<string, any> = {
    _id: event._id,
    name: event.name,
    description: event.description,
    venue: event.venue,
    eventDate: event.eventDate,
    startTime: event.startTime,
    endTime: event.endTime,
    posterUrl: event.posterUrl,
    thumbnailUrl: event.thumbnailUrl,
    ticketTypes: tts.map((tt) => ({
      _id: tt._id, name: tt.name, description: tt.description, price: tt.price,
      available: tt.available, isSoldOut: tt.isSoldOut || tt.available === 0,
    })),
    isSoldOut: tts.every((tt) => tt.isSoldOut || tt.available === 0),
    priceRange: {
      min: Math.min(...tts.map((tt) => tt.price)),
      max: Math.max(...tts.map((tt) => tt.price)),
    },
  };
  if ('organizer' in extras) card.organizer = extras.organizer ?? null;
  if ('recentSales' in extras) card.recentSales = extras.recentSales;
  if ('trending' in extras) card.trending = extras.trending;
  if ('likeCount' in extras) card.likeCount = extras.likeCount;
  if ('viewerHasLiked' in extras) card.viewerHasLiked = extras.viewerHasLiked;
  return card;
}
