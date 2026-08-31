// api/src/models/operatorEventScope.schema.ts
import { Schema } from 'mongoose';

/**
 * Shared event-assignment mechanism for the actors that sell or work an event:
 * the operator populations (gate, reseller) and the reseller company itself.
 * Adds the `eventIds` set naming the events that actor is allowed to work.
 *
 * An EMPTY set means "every event" — which is exactly how these actors behaved
 * before assignment existed, so the default leaves every already-created row
 * untouched and needs no backfill.
 *
 * Unlike the pin, `eventIds` is assignment metadata rather than a secret, so it
 * deliberately stays in the serialized document — the dashboard reads it back
 * to render who is assigned where.
 */
export function applyOperatorEventScope(schema: Schema): void {
  schema.add({
    eventIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Event' }], default: [], index: true },
  });
}
