// api/src/services/operatorEventScope.service.ts
import { Request } from 'express';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Event } from '@models/event.model';
import { ICashier } from '@interfaces/cashier.interface';

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
 * The two shapes an operator's event assignment can take.
 *
 * Gate and reseller operators are genuinely multi-event and carry the shared
 * `eventIds` set (see operatorEventScope.schema.ts). A cashier is hired for
 * exactly ONE event and carries a singular, immutable `eventId` instead —
 * reading `eventIds` off a cashier finds nothing and would resolve to "no
 * assignment", i.e. UNRESTRICTED. That is the wrong way to fail, so the two
 * populations are discriminated here rather than read through one field name.
 */
type OperatorRef =
  | { assignment: 'many'; model: typeof GateOperator | typeof ResellerOperator; id: string }
  | { assignment: 'one'; model: typeof Cashier; id: string };

/**
 * Which operator row (if any) this request is acting as.
 *
 * Returns null for every actor that is not an event-assignable operator:
 * organizers and platform staff acting in the dashboard, and reseller OWNER
 * tokens — those set `operatorId` to the reseller's own id (there is no
 * operator row behind them), so an id equal to `resellerId` is the owner.
 */
function operatorRefOf(req: Request): OperatorRef | null {
  const ticketsUser = (req as any).ticketsUser;
  if (ticketsUser?.userType === 'gate-operator' && ticketsUser.userId) {
    return { assignment: 'many', model: GateOperator, id: String(ticketsUser.userId) };
  }

  const cashier = (req as any).cashier;
  if (cashier?.cashierId) {
    return { assignment: 'one', model: Cashier, id: String(cashier.cashierId) };
  }

  const reseller = (req as any).reseller;
  if (reseller?.operatorId && String(reseller.operatorId) !== String(reseller.resellerId)) {
    return { assignment: 'many', model: ResellerOperator, id: String(reseller.operatorId) };
  }

  return null;
}

/**
 * The events this caller may act on, or null when they are unrestricted.
 *
 * null means "no restriction" and covers four cases: the caller is not an
 * operator at all, a multi-event operator has no assignment (empty set =
 * every event, the pre-assignment behaviour), the caller is a PLATFORM
 * cashier (Carrot's own staff, legitimately global), or the token names a
 * multi-event operator row that no longer exists.
 *
 * An EMPTY ARRAY is the opposite — it denies every event — and is returned
 * only on the cashier path, for the two rows that must not be trusted: an
 * organizer cashier carrying no event, and a row that has been deleted. See
 * the branch itself for why each fails closed.
 *
 * A DB failure is NOT swallowed into null — it propagates, so an outage
 * surfaces as a 500 instead of silently widening access.
 */
export async function resolveOperatorEventScope(req: Request): Promise<string[] | null> {
  const ref = operatorRefOf(req);
  if (!ref) return null;

  if (ref.assignment === 'one') {
    // Read the SINGULAR eventId — a cashier has no eventIds set at all. The
    // Pick<ICashier, …> annotation documents the shape and catches a rename
    // on the INTERFACE, but note .lean<T>() is an unchecked cast: dropping
    // the field from the SCHEMA while leaving it on ICashier would still
    // compile. It is a help, not a guarantee — the fail-closed branch below
    // is what actually holds the line.
    const cashier = await Cashier.findById(ref.id).select('eventId scope')
      .lean<Pick<ICashier, 'eventId' | 'scope'> | null>();

    // A VANISHED row denies too, unlike the 'many' path below which reads a
    // missing operator as unrestricted. A cashier token always names a real
    // row, so nothing here means a deleted or unknown actor.
    //
    // This is not hypothetical: cleanup-eventless-cashiers.ts DELETES legacy
    // rows, and authenticateCashier verifies the JWT with no database lookup
    // at all while CashierAuthService mints 7-day tokens. Resolving to null
    // would therefore flip a deleted cashier from "denied everywhere" (the
    // empty-array case below) to "allowed everywhere" for up to a week —
    // and since loadCashlessEvent does no vendor comparison of its own and
    // event ids are public (they sit in /event/<slug>-<24hex> URLs), she
    // could top up and cash out at any published cashless event of any
    // organizer. Deactivating instead of deleting would not help either;
    // isActive is not re-checked at request time.
    if (!cashier) return [];

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

  const operator: { eventIds?: unknown[] } | null = await (ref.model as any).findById(ref.id).select('eventIds').lean();
  const eventIds: unknown[] = operator?.eventIds ?? [];
  if (!eventIds.length) return null;

  return eventIds.map(String);
}

/** Whether this caller may act on `eventId`. A restricted operator with no event named cannot act. */
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
 * Validates an event assignment submitted when creating or updating an
 * operator.
 *
 * `vendorId` is the vendor the OPERATOR belongs to — not the caller's own. A
 * super-admin creating staff on an organizer's behalf must still be held to
 * that organizer's catalogue, otherwise "assign to event" becomes a way to
 * point one organizer's staff at another's show. Pass undefined for a
 * platform-scoped operator, where only existence is checked.
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
