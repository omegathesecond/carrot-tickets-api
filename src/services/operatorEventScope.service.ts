// api/src/services/operatorEventScope.service.ts
import { Request } from 'express';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
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

type OperatorRef = { model: typeof GateOperator | typeof Cashier | typeof ResellerOperator; id: string };

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
    return { model: GateOperator, id: String(ticketsUser.userId) };
  }

  const cashier = (req as any).cashier;
  if (cashier?.cashierId) {
    return { model: Cashier, id: String(cashier.cashierId) };
  }

  const reseller = (req as any).reseller;
  if (reseller?.operatorId && String(reseller.operatorId) !== String(reseller.resellerId)) {
    return { model: ResellerOperator, id: String(reseller.operatorId) };
  }

  return null;
}

/**
 * The events this caller may act on, or null when they are unrestricted.
 *
 * null means "no restriction" and covers three cases: the caller is not an
 * operator at all, the operator has no assignment (empty set = every event,
 * the pre-assignment behaviour), or the token names an operator row that no
 * longer exists. A DB failure is NOT swallowed into null — it propagates, so
 * an outage surfaces as a 500 instead of silently widening access.
 */
export async function resolveOperatorEventScope(req: Request): Promise<string[] | null> {
  const ref = operatorRefOf(req);
  if (!ref) return null;

  const operator = await (ref.model as any).findById(ref.id).select('eventIds').lean();
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
