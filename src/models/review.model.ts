import { Schema, model, Document, Types } from 'mongoose';

/**
 * A verified post-event review (spec §2.6), OR a service-business review
 * (eventId absent — a Vendor with operatorType:'services' sells no tickets,
 * so there is no event to key the review to). Ticket-holders write one
 * per buyer per event; service-business reviewers write one per buyer per
 * vendor. The organizer may attach exactly one public reply. Aggregates
 * surface on the organizer profile and event pages — ReviewService.
 * vendorAggregate is keyed on vendorId, so it counts service reviews
 * automatically.
 */
export interface IReview extends Document {
  eventId?: Types.ObjectId;
  vendorId: Types.ObjectId;
  buyerId: Types.ObjectId;
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
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
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
  { timestamps: true }
);

// Two disjoint partial-unique indexes rather than one plain unique index:
// an event review is unique per {eventId, buyerId}; a service review (no
// eventId) is unique per {vendorId, buyerId}. Keeping them partial (instead
// of one compound index) means two service reviews to DIFFERENT vendors from
// the same buyer never collide — both would otherwise share eventId: null.
//
// NOTE on the second filter: MongoDB's partialFilterExpression grammar does
// NOT accept `$exists: false` (createIndex rejects it server-side — "Expression
// not supported in partial index: $not"; verified against a real mongod via
// mongodb-memory-server, not just mocked). `{ eventId: null }` is a plain
// equality expression (which partial filters DO support) that matches both a
// missing eventId and an explicit null — since eventId is never set to an
// explicit null anywhere in this codebase, that's exactly "eventId absent".
reviewSchema.index({ eventId: 1, buyerId: 1 }, { unique: true, partialFilterExpression: { eventId: { $exists: true } } });
reviewSchema.index({ vendorId: 1, buyerId: 1 }, { unique: true, partialFilterExpression: { eventId: null } });
reviewSchema.index({ vendorId: 1, createdAt: -1 });
reviewSchema.index({ eventId: 1, createdAt: -1 });

export const Review = model<IReview>('Review', reviewSchema);
