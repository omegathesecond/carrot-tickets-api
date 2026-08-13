import { Schema, model, Document, Types } from 'mongoose';

/**
 * A review of a BUSINESS-kind vendor (event-services supplier — Sound Hire,
 * Catering, ...). Sibling of @models/review.model's event Review, but
 * deliberately NOT ticket-gated: a business never sells tickets, so there is
 * no "holder of a ticket to this vendor" to require. Any signed-in buyer may
 * post one review per business.
 */
export interface IBusinessReview extends Document {
  vendorId: Types.ObjectId;
  buyerId: Types.ObjectId;
  rating: number;
  text?: string;
  createdAt: Date;
  updatedAt: Date;
}

const businessReviewSchema = new Schema<IBusinessReview>(
  {
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
  },
  { timestamps: true }
);

businessReviewSchema.index({ vendorId: 1, buyerId: 1 }, { unique: true });
businessReviewSchema.index({ vendorId: 1, createdAt: -1 });

export const BusinessReview = model<IBusinessReview>('BusinessReview', businessReviewSchema);
