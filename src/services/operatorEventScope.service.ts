// api/src/services/operatorEventScope.service.ts
import { Request } from 'express';
import { GateOperator } from '@models/gateOperator.model';
import { Reseller } from '@models/reseller.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Event } from '@models/event.model';

/**
 * Resolves which events the caller is allowed to work.
 *
 * The assignment is read from the DB rather than carried on the JWT on
 * purpose: tokens here live for days, so a token-borne claim would mean
 * re-assigning someone mid-event does not take effect until they log in
 * again — and minting a new claim would 403 every token issued before the
 * deploy (which is exactly what happened when gate tokens gained
 * VIEW_EVENTS). A findById on an indexed _id is cheap enough to avoid both.
 */

/**
 * A resolved scope.
 *
 *   null → no restriction; every event is in reach.
 *   []   → restricted to NOTHING; every event is refused.
 *
 * The two must stay distinct. Collapsing them inverts the guard: a caller
 * whose tiers leave no event in common would read as "unrestricted" and gain
 * the whole catalogue, which is the opposite of what the assignment says.
 */
export type EventScope = string[] | null;

/**
 * Intersects two tiers, treating null as the identity (an unassigned tier
 * narrows nothing). Two assigned tiers with nothing in common yield [], which
 * denies — see EventScope.
 */
function intersectScopes(a: EventScope, b: EventScope): EventScope {
  if (a === null) return b;
  if (b === null) return a;
  const inB = new Set(b);
  return a.filter((id) => inB.has(id));
}

/** An assignment as stored: an empty set means "every event", i.e. no restriction. */
function scopeOf(eventIds: unknown[] | undefined | null): EventScope {
  if (!eventIds || !eventIds.length) return null;
  return eventIds.map(String);
}

/**
 * The reseller company's own tier.
 *
 * A vanished reseller FAILS CLOSED rather than resolving to null. A reseller
 * token always names a real row, so nothing here means a deleted or unknown
 * company — and reseller tokens are verified with no database lookup and last
 * days, so reading a missing row as "unrestricted" would let a deleted
 * partner sell every published event until their token expired.
 */
async function resellerScope(resellerId: string): Promise<EventScope> {
  const reseller = await Reseller.findById(resellerId).select('eventIds').lean();
  if (!reseller) return [];
  return scopeOf(reseller.eventIds as unknown[]);
}

/**
 * An individual till's tier.
 *
 * Unlike the company row above, a missing operator resolves to null — the
 * caller is still held to the reseller tier, which is what actually bounds
 * them. Denying here as well would lock out a till mid-shift over a row that
 * an admin merely re-created.
 */
async function resellerOperatorScope(operatorId: string): Promise<EventScope> {
  const operator = await ResellerOperator.findById(operatorId).select('eventIds').lean();
  return scopeOf(operator?.eventIds as unknown[]);
}

/**
 * The events this caller may act on, or null when they are unrestricted.
 *
 * Reseller callers resolve TWO tiers — the company and, for a till, the
 * operator — intersected. The company tier binds the owner login too: the
 * point of assigning events to a reseller is that the reseller does not see
 * the others, and an owner token that skipped the tier would leave the whole
 * catalogue one login away.
 *
 * A DB failure is NOT swallowed into null — it propagates, so an outage
 * surfaces as a 500 instead of silently widening access.
 */
export async function resolveOperatorEventScope(req: Request): Promise<EventScope> {
  const ticketsUser = (req as any).ticketsUser;
  if (ticketsUser?.userType === 'gate-operator' && ticketsUser.userId) {
    const gate = await GateOperator.findById(String(ticketsUser.userId)).select('eventIds').lean();
    return scopeOf(gate?.eventIds as unknown[]);
  }

  const reseller = (req as any).reseller;
  if (reseller?.resellerId) {
    const company = await resellerScope(String(reseller.resellerId));

    // The owner login sets operatorId to the reseller's own id — there is no
    // operator row behind it, so the company tier is the whole answer.
    const isOwner = !reseller.operatorId || String(reseller.operatorId) === String(reseller.resellerId);
    if (isOwner) return company;

    return intersectScopes(company, await resellerOperatorScope(String(reseller.operatorId)));
  }

  return null;
}

/** Whether this caller may act on `eventId`. A restricted caller naming no event cannot act. */
export async function operatorMayActOnEvent(req: Request, eventId: string | undefined | null): Promise<boolean> {
  const allowed = await resolveOperatorEventScope(req);
  if (allowed === null) return true;
  if (!eventId) return false;

  return allowed.includes(String(eventId));
}

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export type EventAssignmentResult =
  | { ok: true; eventIds: string[] }
  | { ok: false; message: string };

/**
 * Validates an event assignment submitted when creating or updating an actor.
 *
 * Every id must resolve to a real event. A ghost id would otherwise persist
 * silently and, because an assignment is exhaustive, narrow the actor to a
 * show that does not exist — locking them out of everything with nothing on
 * screen to explain it.
 *
 * `vendorId` is the vendor the ASSIGNED ACTOR belongs to — not the caller's
 * own. Platform staff creating on an organizer's behalf must still be held to
 * that organizer's catalogue, otherwise "assign to event" becomes a way to
 * point one organizer's staff at another's show. Pass undefined for a
 * platform-scoped actor such as a reseller, where only existence is checked.
 */
export async function validateEventAssignment(
  raw: unknown,
  vendorId: string | undefined,
): Promise<EventAssignmentResult> {
  if (!Array.isArray(raw)) return { ok: false, message: 'eventIds must be an array of event ids' };
  if (!raw.length) return { ok: true, eventIds: [] };

  const eventIds = raw.map(String);
  if (eventIds.some((id) => !OBJECT_ID.test(id))) {
    return { ok: false, message: 'eventIds must all be valid event ids' };
  }

  const unique = [...new Set(eventIds)];
  const filter: Record<string, unknown> = { _id: { $in: unique } };
  if (vendorId) filter['vendorId'] = vendorId;

  const found = await Event.countDocuments(filter);
  if (found !== unique.length) {
    return { ok: false, message: 'One or more events do not exist or belong to a different organizer' };
  }

  return { ok: true, eventIds: unique };
}
