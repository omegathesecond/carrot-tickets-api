import { Types } from 'mongoose';
import { BusinessReview, IBusinessReview } from '@models/businessReview.model';
import { Vendor } from '@models/vendor.model';
import { AccountKind } from '@interfaces/vendor.interface';
import { IBuyer } from '@models/buyer.model';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';

export interface BusinessReviewView {
  id: string;
  rating: number;
  text: string | null;
  reviewer: BuyerSummary;
  createdAt: Date;
}

export class BusinessReviewService {
  static async submitReview(
    vendorId: string,
    buyer: IBuyer,
    input: { rating: number; text?: string }
  ): Promise<IBusinessReview> {
    assertNotSuspended(buyer);
    const vendor = await Vendor.findById(vendorId).select('accountKind isActive');
    if (!vendor || !vendor.isActive || vendor.accountKind !== AccountKind.BUSINESS) {
      throw new HttpError(404, 'Business not found');
    }

    try {
      return await BusinessReview.create({
        vendorId: vendor._id,
        buyerId: buyer._id,
        rating: input.rating,
        text: input.text || undefined,
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'You have already reviewed this business');
      throw err;
    }
  }

  static async listForBusiness(
    vendorId: string,
    opts: { before?: string; limit?: number } = {}
  ): Promise<BusinessReviewView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { vendorId };
    if (opts.before) query['_id'] = { $lt: opts.before };
    const docs = await BusinessReview.find(query)
      .sort({ _id: -1 })
      .limit(limit)
      .populate('buyerId', 'username name avatarUrl');
    return docs.map((doc) => BusinessReviewService.toView(doc));
  }

  static async getView(reviewId: string): Promise<BusinessReviewView> {
    const doc = await BusinessReview.findById(reviewId).populate('buyerId', 'username name avatarUrl');
    if (!doc) throw new HttpError(404, 'Review not found');
    return BusinessReviewService.toView(doc);
  }

  static async aggregate(vendorId: string): Promise<{ average: number | null; count: number }> {
    const [row] = await BusinessReview.aggregate([
      { $match: { vendorId: new Types.ObjectId(vendorId) } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    if (!row) return { average: null, count: 0 };
    return { average: Math.round(row.average * 10) / 10, count: row.count };
  }

  private static toView(doc: any): BusinessReviewView {
    const reviewer =
      doc.buyerId && typeof doc.buyerId === 'object' && doc.buyerId._id
        ? toBuyerSummary(doc.buyerId)
        : { id: String(doc.buyerId), username: null, name: null, avatarUrl: null };
    return {
      id: String(doc._id),
      rating: doc.rating,
      text: doc.text ?? null,
      reviewer,
      createdAt: doc.createdAt,
    };
  }
}
