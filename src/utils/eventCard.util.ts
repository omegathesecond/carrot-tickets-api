export interface PublicEventCardExtras {
  recentSales?: number;
  trending?: boolean;
  viewerHasLiked?: boolean;
  likeCount?: number;
  organizer?: { id: string; businessName: string; logoUrl: string | null } | null;
}

/** The fields both public event serializers need — {@link toPublicEventCard}
 *  (the `/public/events` DTO) and the feed EVENT slide (feed.service.ts).
 *  Extracted so a new event-card field is added in exactly ONE place; the
 *  feed's parity test (eventCardParity.test.ts) fails if a caller stops
 *  spreading this into its own slide/card shape. */
export function buildEventCardFields(event: any) {
  const tts: any[] = event.ticketTypes ?? [];
  const prices = tts.map((tt) => tt.price);
  return {
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
    // An event with no ticket types yet has nothing to be sold out OF —
    // `.every()` on an empty array is vacuously true, which would wrongly
    // mark a ticketless event as sold out.
    isSoldOut: tts.length > 0 && tts.every((tt) => tt.isSoldOut || tt.available === 0),
    // `Math.min/max(...[])` on an empty array is +-Infinity, not a real
    // price range — an event with no ticket types yet has no prices at all.
    priceRange: prices.length
      ? { min: Math.min(...prices), max: Math.max(...prices) }
      : { min: 0, max: 0 },
    // Intrinsic event properties (not extras) — every surface needs to know
    // whether this event sells through Carrot or hands off to the organizer's
    // own external ticket seller. Legacy events predating these fields have
    // neither, so they fall back to carrot/null rather than surfacing undefined.
    ticketing: event.ticketing ?? 'carrot',
    externalTicketUrl: event.externalTicketUrl ?? null,
    // Organizer-set category — powers Home/Discover category chips + poster
    // badge. Legacy events predating this field (or serialized through a
    // .select() projection that omits it) fall back to 'Other' rather than
    // surfacing undefined.
    category: event.category ?? 'Other',
  };
}

/** THE public "event card" DTO. Base fields are always emitted; the optional
 *  extras are emitted ONLY when the caller passes the key, so each existing
 *  call site reproduces its exact prior response shape (no silent widening). */
export function toPublicEventCard(event: any, extras: PublicEventCardExtras = {}) {
  const card: Record<string, any> = {
    _id: event._id,
    ...buildEventCardFields(event),
  };
  if ('organizer' in extras) card.organizer = extras.organizer ?? null;
  if ('recentSales' in extras) card.recentSales = extras.recentSales;
  if ('trending' in extras) card.trending = extras.trending;
  if ('likeCount' in extras) card.likeCount = extras.likeCount;
  if ('viewerHasLiked' in extras) card.viewerHasLiked = extras.viewerHasLiked;
  return card;
}
