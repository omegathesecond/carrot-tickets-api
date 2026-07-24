import { toPublicEventCard } from '@/utils/eventCard.util';

const baseEvent = {
  _id: 'e1', name: 'Bushfire', description: 'd', venue: 'House on Fire',
  eventDate: new Date('2026-08-01'), startTime: new Date(), endTime: new Date(),
  posterUrl: 'p', thumbnailUrl: 't', likeCount: 4,
  ticketTypes: [
    { _id: 'tt1', name: 'GA', description: '', price: 100, available: 5, isSoldOut: false },
    { _id: 'tt2', name: 'VIP', description: '', price: 300, available: 0, isSoldOut: true },
  ],
};

it('maps ticketTypes to a priceRange and marks sold-out tiers', () => {
  const card = toPublicEventCard(baseEvent);
  expect(card.priceRange).toEqual({ min: 100, max: 300 });
  expect(card.ticketTypes[1]?.isSoldOut).toBe(true);
});

it('emits ONLY base fields when no extras are given (no shape widening)', () => {
  const card = toPublicEventCard(baseEvent);
  expect('organizer' in card).toBe(false);
  expect('recentSales' in card).toBe(false);
  expect('trending' in card).toBe(false);
  expect('likeCount' in card).toBe(false);
  expect('viewerHasLiked' in card).toBe(false);
});

it('always includes ticketing + externalTicketUrl as base fields, falling back to carrot/null for legacy events', () => {
  const card = toPublicEventCard(baseEvent); // baseEvent has neither field
  expect(card.ticketing).toBe('carrot');
  expect(card.externalTicketUrl).toBeNull();
});

it('always includes category as a base field, falling back to Other for legacy events', () => {
  const card = toPublicEventCard(baseEvent); // baseEvent has no category field
  expect(card.category).toBe('Other');
});

it('reads category straight off the event when present', () => {
  const card = toPublicEventCard({ ...baseEvent, category: 'Music' });
  expect(card.category).toBe('Music');
});

it('reads ticketing + externalTicketUrl straight off the event when present', () => {
  const card = toPublicEventCard({ ...baseEvent, ticketing: 'external', externalTicketUrl: 'https://x.tickets/e' });
  expect(card.ticketing).toBe('external');
  expect(card.externalTicketUrl).toBe('https://x.tickets/e');
});

it('falls back to an empty priceRange and isSoldOut:false when ticketTypes is empty', () => {
  // Math.min/max(...[]) is +-Infinity and .every() on [] is vacuously true —
  // neither is a meaningful answer for an event with no ticket types yet.
  const card = toPublicEventCard({ ...baseEvent, ticketTypes: [] });
  expect(card.priceRange).toEqual({ min: 0, max: 0 });
  expect(card.isSoldOut).toBe(false);
});

it('emits posterUrl/thumbnailUrl as null (not omitted) for a poster-less event', () => {
  const { posterUrl, thumbnailUrl, ...posterless } = baseEvent;
  const card = toPublicEventCard(posterless);
  expect(card.posterUrl).toBeNull();
  expect(card.thumbnailUrl).toBeNull();
  expect(Object.prototype.hasOwnProperty.call(card, 'posterUrl')).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(card, 'thumbnailUrl')).toBe(true);
});

it('includes only the extras it is given', () => {
  const card = toPublicEventCard(baseEvent, {
    organizer: { id: 'v1', businessName: 'MTN Bushfire', logoUrl: null },
    recentSales: 12, trending: true, likeCount: 4, viewerHasLiked: true,
  });
  expect(card.organizer?.businessName).toBe('MTN Bushfire');
  expect(card.recentSales).toBe(12);
  expect(card.trending).toBe(true);
  expect(card.likeCount).toBe(4);
  expect(card.viewerHasLiked).toBe(true);
});
