/**
 * Event discovery-window filters.
 *
 * Buyer-facing discovery surfaces (the public event listing, the Discover
 * feed, and an organizer's public profile) must keep an event listed until it
 * actually ENDS — not until its start instant passes.
 *
 * These queries previously filtered on `eventDate >= now`. Because `eventDate`
 * holds the event's START instant, any event fell off discovery the moment it
 * began: a late-night show stored as 12:00 → 02:00 vanished from the grid at
 * midday, even though it was still running and still selling gate tickets.
 * Filtering on `endTime` instead keeps the event discoverable and buyable right
 * up to the moment it finishes, after which it naturally drops off.
 *
 * `endTime` is a required field on the Event schema, so every event has one.
 *
 * Both helpers return a single-key fragment (no `$or`), so they compose safely
 * with the public listing's text-search `$or`. Spread or Object.assign into a
 * query alongside the other conditions:
 *   Event.find({ status: EventStatus.PUBLISHED, ...notEndedFilter() })
 */

/** Matches events that have not ended yet (still on the grid). */
export function notEndedFilter(now: Date = new Date()): { endTime: { $gte: Date } } {
  return { endTime: { $gte: now } };
}

/** Matches events that have already ended (the complement of notEndedFilter). */
export function endedFilter(now: Date = new Date()): { endTime: { $lt: Date } } {
  return { endTime: { $lt: now } };
}
