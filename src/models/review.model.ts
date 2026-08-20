import { Schema, model, Document, Types } from 'mongoose';

/**
 * A verified post-event review (spec §2.6), OR a service-business review
 * (eventId absent — a Vendor with operatorType:'services' sells no tickets,
 * so there is no event to key the review to).
 *
 * The REVIEWED party is always `vendorId`. The REVIEWER is polymorphic: a
 * buyer (`buyerId`) OR — for service-business reviews only — a fellow organizer
 * (`reviewerVendorId`), so an organizer can review a business without a
 * separate buyer account. Exactly one reviewer field is set (see the
 * pre-validate hook); event reviews are always buyer-authored.
 *
 * Uniqueness is one review per reviewer per business/event. The organizer being
 * reviewed may attach exactly one public reply. Aggregates surface on the
 * organizer profile and event pages — ReviewService.vendorAggregate is keyed on
 * vendorId, so it counts every service review (buyer- or organizer-authored).
 */
export interface IReview extends Document {
  eventId?: Types.ObjectId;
  vendorId: Types.ObjectId;
  /** Buyer reviewer (event reviews always; service reviews when a buyer wrote it). */
  buyerId?: Types.ObjectId;
  /** Organizer reviewer — service-business reviews only. XOR with buyerId. */
  reviewerVendorId?: Types.ObjectId;
  rating: number;
  text?: string;
  verified: boolean;
  organizerReply?: { text: string; repliedAt: Date };
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: false },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    // Reviewer is buyerId XOR reviewerVendorId (enforced below) — so both are
    // optional at the field level, unlike the old buyer-only model.
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: false },
    reviewerVendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: false },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: { validator: Number.isInteger, message: 'Rating must be a whole number' },
    },
    text: { type: String, trim: true, maxlength: 1000 },
    verified: { type: Boolean, required: true, default: false },
    organizerReply: {
      type: new Schema(
        { text: { type: String, required: true, trim: true, maxlength: 1000 }, repliedAt: { type: Date, required: true } },
        { _id: false }
      ),
    },
  },
  {
    timestamps: true,
    // Mongoose's default (connection-level) autoIndex would otherwise race
    // migrateReviewIndexes() (called at app.ts boot, non-test envs only) to
    // (re)build this collection's indexes the instant this model registers
    // on an open connection — if that background build wins while the
    // legacy pre-migration eventId_1_buyerId_1 index (non-partial) still
    // exists in the target DB, it throws IndexKeySpecsConflict instead of
    // ever landing the partial version below. Left on for NODE_ENV==='test'
    // — the test suite's ephemeral in-memory Mongo relies on autoIndex to
    // build these before assertions run (see review.serviceGate.test.ts's
    // explicit Review.init() for a DB where that ordering is asserted, not
    // just assumed). migrateReviewIndexes() is the sole authority for these
    // indexes everywhere else. See src/scripts/migrate-review-indexes.ts.
    autoIndex: process.env['NODE_ENV'] === 'test',
  }
);

// Exactly one reviewer: a buyer XOR a fellow organizer. Event reviews are
// always buyer-authored — an organizer reviewer only makes sense for a
// service-business review (no event to attend). Enforced here rather than at
// the field level because it's a cross-field invariant.
reviewSchema.pre('validate', function (next) {
  const hasBuyer = !!this.buyerId;
  const hasOrganizerReviewer = !!this.reviewerVendorId;
  if (hasBuyer === hasOrganizerReviewer) {
    return next(new Error('A review must have exactly one reviewer (a buyer or an organizer)'));
  }
  if (hasOrganizerReviewer && this.eventId) {
    return next(new Error('An organizer can only review a service business, not an event'));
  }
  next();
});

// Partial-unique indexes, one per reviewer kind, so uniqueness is "one review
// per reviewer per business/event" and reviews to DIFFERENT businesses never
// collide on an absent reviewer field:
//   - event review        unique per {eventId, buyerId}            (eventId present)
//   - buyer service review unique per {vendorId, buyerId}          (event absent, buyer set)
//   - org   service review unique per {vendorId, reviewerVendorId} (event absent, org set)
//
// NOTE on the filters: MongoDB's partialFilterExpression grammar does NOT accept
// `$exists: false` (createIndex rejects it server-side — "Expression not
// supported in partial index: $not"; verified against a real mongod via
// mongodb-memory-server, not just mocked). `{ eventId: null }` is a plain
// equality expression (which partial filters DO support) that matches both a
// missing eventId and an explicit null — since eventId is never set to an
// explicit null anywhere, that's exactly "eventId absent". The `$exists: true`
// clauses scope each service index to ONE reviewer kind, so an organizer review
// (buyerId absent → null) can't collide with other organizers' reviews on the
// buyer index, and vice-versa.
reviewSchema.index({ eventId: 1, buyerId: 1 }, { unique: true, partialFilterExpression: { eventId: { $exists: true } } });
reviewSchema.index(
  { vendorId: 1, buyerId: 1 },
  { unique: true, partialFilterExpression: { eventId: null, buyerId: { $exists: true } } }
);
reviewSchema.index(
  { vendorId: 1, reviewerVendorId: 1 },
  { unique: true, partialFilterExpression: { eventId: null, reviewerVendorId: { $exists: true } } }
);
reviewSchema.index({ vendorId: 1, createdAt: -1 });
reviewSchema.index({ eventId: 1, createdAt: -1 });

export const Review = model<IReview>('Review', reviewSchema);
