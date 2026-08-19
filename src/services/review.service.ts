import { Types } from 'mongoose';
import { Review, IReview } from '@models/review.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { VISIBLE_BUSINESS_FILTER } from '@utils/businessVisibility.util';
import { isTicketHolderForBuyer } from '@utils/ticketHolder.util';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import { EnquiryService } from '@services/enquiry.service';

export interface ReviewView {
  id: string;
  rating: number;
  text: string | null;
  // The reviewer is a buyer OR a fellow organizer (a services business is a
  // Vendor). `isBusiness` lets the UI tag an organizer's review distinctly from
  // a customer's; it's absent/false for buyer reviews, so existing (event)
  // review rendering is unaffected.
  reviewer: BuyerSummary & { isBusiness?: boolean };
  organizerReply: { text: string; repliedAt: Date } | null;
  createdAt: Date;
}

export class ReviewService {
  static async submitReview(
    eventId: string,
    buyer: IBuyer,
    input: { rating: number; text?: string }
  ): Promise<IReview> {
    assertNotSuspended(buyer);
    const event = await Event.findById(eventId);
    if (!event || (event.status !== EventStatus.PUBLISHED && event.status !== EventStatus.COMPLETED)) {
      throw new HttpError(404, 'Event not found');
    }

    const endsAt = (event as any).endTime ?? event.eventDate;
    if (new Date() < new Date(endsAt)) {
      throw new HttpError(403, 'Reviews open after the event ends');
    }
    if (!(await isTicketHolderForBuyer(eventId, buyer))) {
      throw new HttpError(403, 'Only ticket holders can review this event');
    }

    try {
      return await Review.create({
        eventId: event._id,
        vendorId: event.vendorId,
        buyerId: buyer._id,
        rating: input.rating,
        text: input.text || undefined,
        verified: true, // only verified holders reach this point
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'You have already reviewed this event');
      throw err;
    }
  }

  static async listEventReviews(
    eventId: string,
    opts: { before?: string; limit?: number } = {}
  ): Promise<ReviewView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { eventId };
    if (opts.before) query['_id'] = { $lt: opts.before };
    const docs = await Review.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('buyerId', 'username name avatarUrl').populate('reviewerVendorId', 'businessName logoUrl slug');
    return docs.map((doc) => ReviewService.toView(doc));
  }

  /** Task E2: a services business sells no tickets, so eligibility to review
   *  is gated on proof-of-contact (D1's EnquiryService.hasEnquired) instead
   *  of ticket-holding. The review carries vendorId with NO eventId — E1's
   *  partial-unique-index shape enforces one review per buyer per business. */
  static async submitServiceReview(
    businessId: string,
    buyer: IBuyer,
    input: { rating: number; text?: string }
  ): Promise<IReview> {
    assertNotSuspended(buyer);
    const biz = await Vendor.findOne({ _id: businessId, ...VISIBLE_BUSINESS_FILTER }).select('_id');
    if (!biz) throw new HttpError(404, 'Business not found');
    if (!(await EnquiryService.hasEnquired(String(buyer._id), businessId))) {
      throw new HttpError(403, 'Only customers who have enquired can review this business');
    }
    try {
      return await Review.create({
        vendorId: biz._id,
        buyerId: buyer._id,
        rating: input.rating,
        text: input.text || undefined,
        verified: true, // only enquiry-verified contacts reach this point
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'You have already reviewed this business');
      throw err;
    }
  }

  /** An ORGANIZER (any Vendor) reviewing a services business. Unlike the buyer
   *  path there's no enquiry gate — a signed-in organizer can review any
   *  business to interact with it — but a business can't review ITSELF, and the
   *  {vendorId, reviewerVendorId} partial-unique index still enforces one review
   *  per organizer per business. The review carries reviewerVendorId (no
   *  buyerId, no eventId). */
  static async submitBusinessReviewAsOrganizer(
    businessId: string,
    reviewerVendorId: string,
    input: { rating: number; text?: string }
  ): Promise<IReview> {
    if (String(reviewerVendorId) === String(businessId)) {
      throw new HttpError(400, 'You cannot review your own business');
    }
    // Same visibility rule as the buyer path and the directory: verification is
    // a badge, not a gate — a PENDING business is reviewable; only REJECTED /
    // SUSPENDED / inactive / non-services are hidden (404).
    const biz = await Vendor.findOne({ _id: businessId, ...VISIBLE_BUSINESS_FILTER }).select('_id');
    if (!biz) throw new HttpError(404, 'Business not found');
    try {
      return await Review.create({
        vendorId: biz._id,
        reviewerVendorId: new Types.ObjectId(reviewerVendorId),
        rating: input.rating,
        text: input.text || undefined,
        verified: true, // an authenticated organizer is a verified contact
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'You have already reviewed this business');
      throw err;
    }
  }

  /** Event-less reviews for a services business — eventId is NEVER set on
   *  these docs, so `{ $exists: false }` (not `null`) is the correct filter. */
  static async listBusinessReviews(
    businessId: string,
    opts: { before?: string; limit?: number } = {}
  ): Promise<ReviewView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { vendorId: businessId, eventId: { $exists: false } };
    if (opts.before) query['_id'] = { $lt: opts.before };
    const docs = await Review.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('buyerId', 'username name avatarUrl').populate('reviewerVendorId', 'businessName logoUrl slug');
    return docs.map((doc) => ReviewService.toView(doc));
  }

  /** View a single review by id (populated reviewer). */
  static async getView(reviewId: string): Promise<ReviewView> {
    const doc = await Review.findById(reviewId).populate('buyerId', 'username name avatarUrl').populate('reviewerVendorId', 'businessName logoUrl slug');
    if (!doc) throw new HttpError(404, 'Review not found');
    return ReviewService.toView(doc);
  }

  static async eventAggregate(eventId: string): Promise<{ average: number | null; count: number }> {
    return ReviewService.aggregateBy({ eventId: new Types.ObjectId(eventId) });
  }

  static async vendorAggregate(vendorId: string): Promise<{ average: number | null; count: number }> {
    return ReviewService.aggregateBy({ vendorId: new Types.ObjectId(vendorId) });
  }

  private static async aggregateBy(match: Record<string, unknown>): Promise<{ average: number | null; count: number }> {
    const [row] = await Review.aggregate([
      { $match: match },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    if (!row) return { average: null, count: 0 };
    return { average: Math.round(row.average * 10) / 10, count: row.count };
  }

  static async replyToReview(
    reviewId: string,
    vendorId: string,
    isSuperAdmin: boolean,
    text: string
  ): Promise<ReviewView> {
    const review = await Review.findById(reviewId).select('vendorId organizerReply');
    if (!review) throw new HttpError(404, 'Review not found');
    if (!isSuperAdmin && String(review.vendorId) !== String(vendorId)) {
      throw new HttpError(403, 'You can only reply to reviews of your own events');
    }

    // Atomic reply-once: the filter only matches while no reply exists, so
    // concurrent replies can never both win (mirrors the unique-index
    // pattern submitReview uses for duplicates).
    const updated = await Review.findOneAndUpdate(
      { _id: reviewId, organizerReply: { $exists: false } },
      { $set: { organizerReply: { text, repliedAt: new Date() } } },
      { new: true, runValidators: true }
    ).populate('buyerId', 'username name avatarUrl').populate('reviewerVendorId', 'businessName logoUrl slug');
    if (!updated) throw new HttpError(409, 'You have already replied to this review');
    return ReviewService.toView(updated);
  }

  private static toView(doc: any): ReviewView {
    const org = doc.reviewerVendorId;
    let reviewer: ReviewView['reviewer'];
    if (org && typeof org === 'object' && org._id) {
      // Organizer reviewer: shape a Vendor into the shared reviewer summary —
      // businessName → name, slug → username, logoUrl → avatarUrl — and flag it
      // so the UI can label it a "Business" review.
      reviewer = {
        id: String(org._id),
        username: org.slug ?? null,
        name: org.businessName ?? null,
        avatarUrl: org.logoUrl ?? null,
        isBusiness: true,
      };
    } else if (doc.buyerId && typeof doc.buyerId === 'object' && doc.buyerId._id) {
      reviewer = toBuyerSummary(doc.buyerId);
    } else {
      reviewer = { id: String(doc.reviewerVendorId ?? doc.buyerId), username: null, name: null, avatarUrl: null };
    }
    return {
      id: String(doc._id),
      rating: doc.rating,
      text: doc.text ?? null,
      reviewer,
      organizerReply: doc.organizerReply
        ? { text: doc.organizerReply.text, repliedAt: doc.organizerReply.repliedAt }
        : null,
      createdAt: doc.createdAt,
    };
  }
}
