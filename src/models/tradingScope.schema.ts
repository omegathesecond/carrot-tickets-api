import { Schema } from 'mongoose';

/**
 * Event-or-venue ownership for cashless and stock documents (venue trading
 * spec § Architecture). Adds `venueId` and enforces EXACTLY ONE owner: a
 * document with both, or neither, fails validation. The host schema declares
 * `eventId` WITHOUT `required` — this hook is the single owner rule.
 *
 * Document validation only: an `updateOne`/`findOneAndUpdate` upsert does not
 * run it, so every upsert that can insert one of these documents must write
 * the owner itself (StockService.applyMovement does, via scopeMatch).
 */
export function applyTradingScope(schema: Schema): void {
  schema.add({ venueId: { type: Schema.Types.ObjectId, ref: 'Venue' } });
  schema.pre('validate', function (next) {
    const hasEvent = this.get('eventId') != null;
    const hasVenue = this.get('venueId') != null;
    if (hasEvent === hasVenue) {
      this.invalidate('venueId', 'exactly one of eventId or venueId is required');
    }
    next();
  });
}

/**
 * Options for every venueId-led index on these models. Event documents carry
 * no venueId, so a plain index would hold one null entry per event document;
 * partial, it holds venue documents only. A `{ venueId: X, … }` equality query
 * still uses it — X is never null, which implies `$exists`.
 */
export const VENUE_ONLY_INDEX = { partialFilterExpression: { venueId: { $exists: true } } };
