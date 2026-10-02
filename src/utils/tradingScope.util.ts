import mongoose from 'mongoose';

/**
 * Who owns a piece of cashless data: one event, or one venue (venue trading
 * spec § Architecture). Resolved per request by eventScope / venueScope.
 */
export type TradingScope =
  | { kind: 'event'; eventId: string }
  | { kind: 'venue'; venueId: string };

type Id = string | mongoose.Types.ObjectId;

/**
 * Exactly one owner id, as service inputs carry it. Every existing event
 * caller keeps passing `eventId` unchanged; venue callers pass `venueId`. The
 * `?: never` arms make "both" and "neither" compile errors.
 */
export type ScopeIds =
  | { eventId: Id; venueId?: never }
  | { venueId: Id; eventId?: never };

export type ScopeMatch =
  | { eventId: mongoose.Types.ObjectId }
  | { venueId: mongoose.Types.ObjectId };

const oid = (v: Id): mongoose.Types.ObjectId =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v));

export function scopeIds(scope: TradingScope): ScopeIds {
  return scope.kind === 'event' ? { eventId: scope.eventId } : { venueId: scope.venueId };
}

/** The owner as a query filter — and, being the same shape, as the fields to write. */
export function scopeMatch(ids: ScopeIds): ScopeMatch {
  if (ids.venueId != null) return { venueId: oid(ids.venueId) };
  if (ids.eventId != null) return { eventId: oid(ids.eventId) };
  throw new Error('scope requires an eventId or a venueId');
}

type Owned = { eventId?: unknown; venueId?: unknown } | null | undefined;

export function scopeOfDoc(doc: Owned): TradingScope | null {
  if (!doc) return null;
  if (doc.venueId != null) return { kind: 'venue', venueId: String(doc.venueId) };
  if (doc.eventId != null) return { kind: 'event', eventId: String(doc.eventId) };
  return null;
}

/** For code that has already loaded a document the schema guarantees is owned. */
export function requireScopeOf(doc: Owned): TradingScope {
  const scope = scopeOfDoc(doc);
  if (!scope) throw new Error('document has neither an eventId nor a venueId');
  return scope;
}

export function belongsToScope(doc: Owned, scope: TradingScope): boolean {
  const own = scopeOfDoc(doc);
  if (!own || own.kind !== scope.kind) return false;
  return own.kind === 'event'
    ? own.eventId === (scope as { eventId: string }).eventId
    : own.venueId === (scope as { venueId: string }).venueId;
}
