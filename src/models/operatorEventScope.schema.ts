// api/src/models/operatorEventScope.schema.ts
import { Schema } from 'mongoose';

/**
 * Shared event-assignment mechanism for the operator populations (gate,
 * cashier, reseller). Adds the `eventIds` set naming the events the operator
 * is allowed to work.
 *
 * An EMPTY set means "every event this operator's organizer runs" — which is
 * exactly how operators behaved before assignment existed, so the default
 * leaves every already-created operator untouched and needs no backfill.
 *
 * Unlike the pin, `eventIds` is assignment metadata rather than a secret, so
 * it deliberately stays in the serialized document — the dashboard reads it
 * back to render who is assigned where.
 */
export function applyOperatorEventScope(schema: Schema): void {
  schema.add({
    eventIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Event' }], default: [], index: true },
  });
}
