import { Schema, model, Document, Types } from 'mongoose';

/**
 * A verified post-event review (spec §2.6). Only ticket-holders may write
 * one, one per buyer per event; the organizer may attach exactly one public
 * reply. Aggregates surface on the organizer profile and event pages.
 */
export interface IReview extends Document {
  eventId: Types.ObjectId;
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
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
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

reviewSchema.index({ eventId: 1, buyerId: 1 }, { unique: true });
reviewSchema.index({ vendorId: 1, createdAt: -1 });
reviewSchema.index({ eventId: 1, createdAt: -1 });

export const Review = model<IReview>('Review', reviewSchema);
