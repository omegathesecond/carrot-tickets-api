import { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { Venue } from '@models/venue.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { TradingScope, belongsToScope } from '@utils/tradingScope.util';

function actorOf(req: Request) {
  const u = (req as any).ticketsUser;
  return { isSuperAdmin: !!u?.isSuperAdmin, vendorId: u?.vendorId as string | undefined };
}

/**
 * The caller must own the event (super-admin bypasses). Returns the event, or
 * null after sending the right 4xx. Moved here from merchantAdmin.controller so
 * the scope middleware and every stall/stock handler share ONE definition.
 */
export async function loadOwnedEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  if (!eventId) { ApiResponseUtil.badRequest(res, 'eventId is required'); return null; }
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.notFound(res, 'Event not found'); return null; }
  const actor = actorOf(req);
  if (!actor.isSuperAdmin && String(event.vendorId) !== actor.vendorId) {
    ApiResponseUtil.forbidden(res, 'Event belongs to a different vendor'); return null;
  }
  return event;
}

/**
 * Resolve an EVENT scope from `req[from].eventId` under the same owner check
 * the handlers used to run themselves (`requireCashless` → the stock reports'
 * stricter loadOwnedCashlessEvent).
 */
export function eventScope(from: 'params' | 'query' | 'body', opts: { requireCashless?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const source = (from === 'params' ? req.params : from === 'query' ? req.query : req.body || {}) as Record<string, unknown>;
      const eventId = String(source['eventId'] || '');
      const event = opts.requireCashless
        ? await loadOwnedCashlessEvent(req, res, eventId)
        : await loadOwnedEvent(req, res, eventId);
      if (!event) return; // already answered
      (req as any).tradingScope = { kind: 'event', eventId: String(event._id) } as TradingScope;
      (req as any).scopeEvent = event;
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Resolve the signed-in vendor's VENUE scope (venue trading spec). There is no
 * id in a venue URL: the venue is the vendor's own, so another venue cannot be
 * addressed at all.
 */
export async function venueScope(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
    const venue = vendorId && mongoose.isValidObjectId(vendorId)
      ? await Venue.findOne({ vendorId }).lean()
      : null;
    if (!venue) { ApiResponseUtil.notFound(res, 'No venue on this account'); return; }
    if (venue.status !== 'active') { ApiResponseUtil.forbidden(res, 'Venue trading is suspended'); return; }
    (req as any).tradingScope = { kind: 'venue', venueId: String(venue._id) } as TradingScope;
    (req as any).scopeVenue = venue;
    next();
  } catch (e) { next(e); }
}

/** The scope a scope middleware resolved. Throws loudly if a route forgot one. */
export function getScope(req: Request): TradingScope {
  const scope = (req as any).tradingScope as TradingScope | undefined;
  if (!scope) throw new Error('trading scope not resolved — route is missing eventScope/venueScope');
  return scope;
}

/** The scope's owner as a response field: `{ event: {id,name} }` or `{ venue: {id,name} }`. */
export function scopeOwner(req: Request): { event: { id: string; name: string } } | { venue: { id: string; name: string } } {
  const scope = getScope(req);
  const doc = scope.kind === 'event' ? (req as any).scopeEvent : (req as any).scopeVenue;
  if (!doc) throw new Error('trading scope owner not loaded');
  const ref = { id: String(doc._id), name: doc.name as string };
  return scope.kind === 'event' ? { event: ref } : { venue: ref };
}

/**
 * For a handler addressed by a DOCUMENT id (a stall, product or operator's
 * stall): the document must sit inside the route's scope. A venue route
 * already resolved its scope, so a document from another venue — or from an
 * event — reads as not found. A legacy event route (`/merchants/:id`,
 * `/products/:id`) has no scope yet: it is derived from the document's eventId
 * under loadOwnedEvent, which also refuses a venue document (no eventId).
 */
export async function resolveDocScope(
  req: Request, res: Response, doc: { eventId?: unknown; venueId?: unknown }, notFound: string,
): Promise<TradingScope | null> {
  const scope = (req as any).tradingScope as TradingScope | undefined;
  if (scope) {
    if (!belongsToScope(doc, scope)) { ApiResponseUtil.notFound(res, notFound); return null; }
    return scope;
  }
  if (doc.eventId == null) { ApiResponseUtil.notFound(res, notFound); return null; }
  const event = await loadOwnedEvent(req, res, String(doc.eventId));
  if (!event) return null;
  const derived: TradingScope = { kind: 'event', eventId: String(event._id) };
  (req as any).tradingScope = derived;
  (req as any).scopeEvent = event;
  return derived;
}
