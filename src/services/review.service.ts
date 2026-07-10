import { Types } from 'mongoose';
import { Review, IReview } from '@models/review.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { IBuyer } from '@models/buyer.model';
import { isTicketHolder } from '@utils/ticketHolder.util';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';

export interface ReviewView {
  id: string;
  rating: number;
  text: string | null;
  reviewer: BuyerSummary;
  organizerReply: { text: string; repliedAt: Date } | null;
  createdAt: Date;
}

export class ReviewService {
  static async submitReview(
    eventId: string,
    buyer: IBuyer,
    input: { rating: number; text?: string }
  ): Promise<IReview> {
    const event = await Event.findById(eventId);
    if (!event || (event.status !== EventStatus.PUBLISHED && event.status !== EventStatus.COMPLETED)) {
      throw new HttpError(404, 'Event not found');
    }

    const endsAt = (event as any).endTime ?? event.eventDate;
    if (new Date() < new Date(endsAt)) {
      throw new HttpError(403, 'Reviews open after the event ends');
    }
    if (!(await isTicketHolder(eventId, buyer.phone))) {
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
      .populate('buyerId', 'username name avatarUrl');
    return docs.map((doc) => ReviewService.toView(doc));
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
    ).populate('buyerId', 'username name avatarUrl');
    if (!updated) throw new HttpError(409, 'You have already replied to this review');
    return ReviewService.toView(updated);
  }

  private static toView(doc: any): ReviewView {
    const reviewer =
      doc.buyerId && typeof doc.buyerId === 'object' && doc.buyerId._id
        ? toBuyerSummary(doc.buyerId)
        : { id: String(doc.buyerId), username: null, name: null, avatarUrl: null };
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
