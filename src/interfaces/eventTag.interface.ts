// api/src/interfaces/eventTag.interface.ts
import { Document, Types } from 'mongoose';

/**
 * A tag is either usable at this event or it is not — there is no third state.
 * `retired` is kept rather than deleting the row so a tag that was pulled from
 * circulation (damaged, stolen, sold on) stays visible in the registry with the
 * reason it left, and so re-registering it later is an update rather than a
 * silent new row with no history.
 */
export type EventTagStatus = 'active' | 'retired';

/**
 * ONE physical NFC tag enrolled into ONE event's tag pool (the "register").
 *
 * The organizer buys blank tags from Carrot or anywhere else; before a tag can
 * carry money at their show, someone on the Register desk has to enrol it here.
 * That is what stops a stranger walking in with a tag bought elsewhere — or a
 * tag from LAST night's event — and spending on this organizer's float.
 *
 * Deliberately event-scoped rather than global: the same physical tag is
 * legitimately re-used across events (it is wiped and re-registered), and the
 * wallet it maps to is per-event too (see Wallet), so a platform-wide tag
 * identity would carry no useful meaning and would make re-use a conflict.
 */
export interface IEventTag extends Document {
  eventId: Types.ObjectId;
  /** Canonical lowercase hex uid — see normalizeBandUid. */
  bandUid: string;
  status: EventTagStatus;
  /**
   * Operator/organizer id that enrolled it, for the desk's activity trail. The
   * NAME is resolved at read time from that id (same as BandBinding.boundBy in
   * tagReport.service) rather than denormalized here — one source of truth for
   * a person's name, no drift when they are renamed.
   */
  registeredBy?: string;
  registeredAt: Date;
  retiredAt?: Date;
  retiredReason?: string;
  createdAt: Date;
  updatedAt: Date;
}
