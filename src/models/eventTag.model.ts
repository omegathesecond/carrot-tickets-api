// api/src/models/eventTag.model.ts
import mongoose, { Schema } from 'mongoose';
import { IEventTag } from '@interfaces/eventTag.interface';

const eventTagSchema = new Schema<IEventTag>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    // NOTE: no unique/index here on purpose — uniqueness is declared once, below,
    // via schema.index(). Declaring it in both places yields two definitions of
    // the same index name with different options; MongoDB rejects the second and
    // Mongoose swallows the error, so the index silently never exists. (Same
    // trap that cost a prod index build on Vendor.keshlessVendorId.)
    bandUid: { type: String, required: true, trim: true },
    status: { type: String, enum: ['active', 'retired'], default: 'active', required: true },
    registeredBy: { type: String, trim: true },
    registeredAt: { type: Date, default: Date.now },
    retiredAt: { type: Date },
    retiredReason: { type: String, trim: true },
  },
  { timestamps: true },
);

/**
 * One row per (event, tag) — the whole point of the registry. Re-tapping a tag
 * that is already enrolled must be an idempotent no-op rather than a second
 * row, and two desks enrolling the same tag at once must not both win.
 */
eventTagSchema.index({ eventId: 1, bandUid: 1 }, { unique: true });

/** The registry screen: this event's tags, newest enrolment first. */
eventTagSchema.index({ eventId: 1, status: 1, registeredAt: -1 });

export const EventTag = mongoose.model<IEventTag>('EventTag', eventTagSchema);
