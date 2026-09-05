// api/src/services/operatorEventScope.service.ts
import { Request } from 'express';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { Reseller } from '@models/reseller.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Waiter } from '@models/waiter.model';
import { Event } from '@models/event.model';
import { ICashier } from '@interfaces/cashier.interface';
import { IWaiter } from '@interfaces/waiter.interface';

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
  const reseller = await Reseller.findById(resellerId).select('eventIds isActive status').lean();
  if (!reseller) return [];

  // A DEACTIVATED or SUSPENDED company denies too, for the same reason a
  // vanished one does: authenticateReseller does no database lookup and
  // ResellerAuthService mints 7-day tokens, so suspending a partner would
  // otherwise only stop their NEXT LOGIN while every token already in their
  // tills kept selling for the rest of the week. This binds the owner token
  // and, through intersectScopes, every till under the company. The row is
  // already being read here, so this costs nothing beyond two more fields.
  if (!reseller.isActive || reseller.status === 'suspended') return [];

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
  const operator = await ResellerOperator.findById(operatorId).select('eventIds isActive').lean();
  if (!operator) return null;

  // A DEACTIVATED till denies, unlike a missing one. PATCH
  // /reseller/operators/:id {isActive:false} is the only per-person
  // revocation the reseller admin has, and with no database lookup in
  // authenticateReseller and 7-day tokens it would otherwise only stop the
  // NEXT LOGIN — the token in the till kept selling. An empty array here
  // intersects to an empty array whatever the company tier says.
  if (!operator.isActive) return [];

  return scopeOf(operator.eventIds as unknown[]);
}

/**
 * A cashier's tier.
 *
 * Gate and reseller operators are genuinely multi-event and carry the shared
 * `eventIds` set (see operatorEventScope.schema.ts). A cashier is hired for
 * exactly ONE event and carries a singular, immutable `eventId` instead —
 * reading `eventIds` off a cashier finds nothing and would resolve to "no
 * assignment", i.e. UNRESTRICTED. That is the wrong way to fail, so the
 * cashier population is read through its own field here.
 *
 * An EMPTY ARRAY denies every event and is returned for the three rows that
 * must not be trusted: an organizer cashier carrying no event, a row that has
 * been deleted, and a row that has been DEACTIVATED. See each branch for why
 * it fails closed. Only a PLATFORM cashier — Carrot's own staff — resolves to
 * null, because she is legitimately global.
 */
async function cashierScope(cashierId: string): Promise<EventScope> {
  // Read the SINGULAR eventId — a cashier has no eventIds set at all. The
  // Pick<ICashier, …> annotation documents the shape and catches a rename
  // on the INTERFACE, but note .lean<T>() is an unchecked cast: dropping
  // the field from the SCHEMA while leaving it on ICashier would still
  // compile. It is a help, not a guarantee — the fail-closed branches below
  // are what actually hold the line.
  const cashier = await Cashier.findById(cashierId).select('eventId scope isActive')
    .lean<Pick<ICashier, 'eventId' | 'scope' | 'isActive'> | null>();

  // A VANISHED row denies, unlike a missing gate/reseller operator which is
  // read as unrestricted. A cashier token always names a real row, so nothing
  // here means a deleted or unknown actor.
  //
  // This is not hypothetical: cleanup-eventless-cashiers.ts DELETES legacy
  // rows, and authenticateCashier verifies the JWT with no database lookup
  // at all while CashierAuthService mints 7-day tokens. Resolving to null
  // would therefore flip a deleted cashier from "denied everywhere" (the
  // empty-array case below) to "allowed everywhere" for up to a week —
  // and since loadCashlessEvent does no vendor comparison of its own and
  // event ids are public (they sit in /event/<slug>-<24hex> URLs), she
  // could top up and cash out at any published cashless event of any
  // organizer.
  if (!cashier) return [];

  // A DEACTIVATED row denies too, for the same reason a vanished one does:
  // authenticateCashier does no database lookup and CashierAuthService
  // mints 7-day tokens, so PATCH /cashiers/:id {isActive:false} would
  // otherwise only stop her NEXT LOGIN while the token in her hand kept
  // topping up and cashing out for the rest of the week. The row is already
  // being read here, so this costs nothing beyond one more selected field.
  if (!cashier.isActive) return [];

  // `scope` is selected precisely so the two no-event cases can be told
  // apart. An ORGANIZER cashier is REQUIRED to carry an event, so a row
  // without one is a legacy row written before that rule existed — the
  // schema enforces `required` on WRITE, not on read. Falling through to
  // null there would make her unrestricted, and loadCashlessEvent does no
  // vendor comparison of its own, so she could top up and cash out at any
  // published cashless event belonging to ANY organizer. An empty array
  // denies every event instead (allowed.includes() is false for all), so
  // the row surfaces as a 403 and gets cleaned up rather than silently
  // holding global access.
  if (cashier.scope === 'organizer' && !cashier.eventId) return [];

  // Only a PLATFORM cashier — Carrot's own staff — is legitimately global.
  return cashier.eventId ? [String(cashier.eventId)] : null;
}

/**
 * A waiter's tier — the same shape as cashierScope above, and for the same
 * reason.
 *
 * A waiter is hired for exactly ONE event and carries the singular `eventId`,
 * so reading the shared multi-event `eventIds` off one would find nothing and
 * resolve to "no assignment", i.e. UNRESTRICTED. Worse, before this function
 * existed resolveOperatorEventScope had no waiter branch at all and fell
 * through to null, so every waiter was unrestricted regardless.
 *
 * Every failure here returns an EMPTY ARRAY, which denies every event.
 * authenticateWaiter verifies the JWT with no database lookup and
 * WaiterAuthService mints 7-day tokens, so the waiter's ROW is the only place
 * a revocation can land in time: PATCH /waiters/:id {isActive:false} — the
 * only revocation the feature has — would otherwise stop nothing but their
 * NEXT LOGIN while the handheld in their pocket kept settling tabs, debiting
 * attendee wallets and moving stall stock for the rest of the week. A deleted
 * row denies for the same reason, and an organizer waiter carrying no event
 * denies rather than resolving to null, since loadWaiterEvent does no vendor
 * comparison of its own and event ids are public.
 */
async function waiterScope(waiterId: string): Promise<EventScope> {
  const waiter = await Waiter.findById(waiterId).select('eventId scope isActive')
    .lean<Pick<IWaiter, 'eventId' | 'scope' | 'isActive'> | null>();

  if (!waiter) return [];
  if (!waiter.isActive) return [];
  if (waiter.scope === 'organizer' && !waiter.eventId) return [];

  // Only a PLATFORM waiter — Carrot's own staff — is legitimately global.
  return waiter.eventId ? [String(waiter.eventId)] : null;
}

/**
 * The events this caller may act on, or null when they are unrestricted.
 *
 * null covers every actor that is not an event-assignable operator
 * (organizers and platform staff acting in the dashboard, unauthenticated
 * requests), a multi-event operator with no assignment (empty set = every
 * event, the pre-assignment behaviour), a PLATFORM cashier or waiter, and a
 * token naming a gate or reseller operator row that no longer exists.
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
    const gate = await GateOperator.findById(String(ticketsUser.userId)).select('eventIds isActive').lean();

    // A VANISHED row resolves to null (unrestricted) — see the doc comment on
    // this function; requireTicketsPermission refuses a token naming no row
    // before a request ever gets here.
    if (!gate) return null;

    // A DEACTIVATED row denies, for the same reason a deactivated cashier
    // does: authenticateTickets does no database lookup and
    // GateOperatorAuthService mints 7-day tokens, so PATCH /gate-operators/:id
    // {isActive:false} would otherwise only stop their NEXT LOGIN while the
    // token in their hand kept scanning — and, for an unassigned row, kept
    // resolving to null, i.e. every event of every organizer. The row is
    // already being read here, so this costs nothing beyond one more field.
    if (!gate.isActive) return [];

    return scopeOf(gate.eventIds as unknown[]);
  }

  const cashier = (req as any).cashier;
  if (cashier?.cashierId) {
    return cashierScope(String(cashier.cashierId));
  }

  const waiter = (req as any).waiter;
  if (waiter?.waiterId) {
    return waiterScope(String(waiter.waiterId));
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
