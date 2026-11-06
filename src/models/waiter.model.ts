import mongoose, { Schema } from 'mongoose';
import { IWaiter } from '@interfaces/waiter.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';
import { VENUE_ONLY_INDEX } from '@models/tradingScope.schema';

/**
 * Floor waiter for an organizer — opens tables, collects items from several
 * stalls onto them, settles at the end. Same PIN-login shape as Cashier via
 * applyOperatorCredentials.
 *
 * Like a cashier and unlike a gate operator, a waiter works exactly ONE event
 * (or, at a venue, ONE venue), so this carries `eventId` / `venueId` rather
 * than the shared multi-event `eventIds`.
 */
const waiterSchema = new Schema<IWaiter>({
  deletedAt: { type: Date },
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  scope: { type: String, required: true, enum: ['platform', 'organizer'], index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    index: true,
    immutable: true,
    // An organizer waiter works ONE event or ONE venue; a platform waiter neither.
    required: function (this: { scope?: string; venueId?: unknown }) { return this.scope === 'organizer' && this.venueId == null; },
  },
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue', immutable: true },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(waiterSchema, true);

// applyTradingScope is NOT used here: it refuses a document with neither
// owner, and a platform waiter legitimately has neither.
waiterSchema.pre('validate', function (next) {
  const hasVenue = this.get('venueId') != null;
  if (hasVenue && this.get('eventId') != null) {
    this.invalidate('venueId', 'exactly one of eventId or venueId is required');
  }
  if (hasVenue && this.get('scope') === 'platform') {
    this.invalidate('venueId', 'a platform waiter cannot belong to a venue');
  }
  next();
});

waiterSchema.index({ vendorId: 1, isActive: 1 });
waiterSchema.index({ eventId: 1, isActive: 1 });
waiterSchema.index({ venueId: 1, isActive: 1 }, VENUE_ONLY_INDEX);

export const Waiter = mongoose.model<IWaiter>('Waiter', waiterSchema);
