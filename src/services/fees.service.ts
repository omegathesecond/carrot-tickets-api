import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentStatus } from '@interfaces/ticket.interface';
import { round2 } from '@utils/serviceFee.util';

export interface FeeMethodBreakdown {
  method: string;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
  ticketsSold: number;
  salesCount: number;
}

export interface FeeByEventRow {
  eventId: string;
  eventName: string;
  ticketsSold: number;
  faceValue: number;    // Σ totalAmount — the organizer's revenue
  bookingFees: number;  // Σ serviceFeeAmount — buyer-paid booking fee
  platformFees: number; // Σ platformFeeAmount — platform commission
  totalFees: number;    // bookingFees + platformFees — Carrot's take
  byMethod: FeeMethodBreakdown[];
}

export interface FeeTotals {
  eventCount: number;
  ticketsSold: number;
  faceValue: number;
  bookingFees: number;
  platformFees: number;
  totalFees: number;
}

export interface FeesByEventResult {
  events: FeeByEventRow[];
  totals: FeeTotals;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface GetFeesByEventParams {
  startDate?: Date;
  endDate?: Date;
  eventId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

const EMPTY_TOTALS: FeeTotals = {
  eventCount: 0, ticketsSold: 0, faceValue: 0, bookingFees: 0, platformFees: 0, totalFees: 0,
};

export class FeesService {
  /**
   * Per-event fees Carrot has collected — booking fee (serviceFeeAmount, buyer-paid
   * online, on top of face) + platform commission (platformFeeAmount, % of face,
   * all channels). Completed sales only. `totals` summarise the whole filtered set
   * (all pages); `events` is one page, highest total fee first.
   */
  static async getFeesByEvent(params: GetFeesByEventParams): Promise<FeesByEventResult> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));

    const match: Record<string, unknown> = { paymentStatus: PaymentStatus.COMPLETED };
    if (params.eventId) match['eventId'] = new mongoose.Types.ObjectId(params.eventId);
    if (params.startDate || params.endDate) {
      const soldAt: Record<string, Date> = {};
      if (params.startDate) soldAt['$gte'] = params.startDate;
      if (params.endDate) soldAt['$lte'] = params.endDate;
      match['soldAt'] = soldAt;
    }

    const nameStage = params.search
      ? [{ $match: { eventName: new RegExp(params.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } }]
      : [];

    const agg = await TicketSale.aggregate([
      { $match: match },
      // 1) collapse to event+method buckets
      {
        $group: {
          _id: { eventId: '$eventId', method: '$paymentMethod' },
          bookingFees: { $sum: { $ifNull: ['$serviceFeeAmount', 0] } },
          platformFees: { $sum: { $ifNull: ['$platformFeeAmount', 0] } },
          faceValue: { $sum: { $ifNull: ['$totalAmount', 0] } },
          ticketsSold: { $sum: '$quantity' },
          salesCount: { $sum: 1 },
        },
      },
      // 2) roll methods up into one doc per event, keeping the method breakdown
      {
        $group: {
          _id: '$_id.eventId',
          bookingFees: { $sum: '$bookingFees' },
          platformFees: { $sum: '$platformFees' },
          faceValue: { $sum: '$faceValue' },
          ticketsSold: { $sum: '$ticketsSold' },
          byMethod: {
            $push: {
              method: '$_id.method',
              bookingFees: '$bookingFees',
              platformFees: '$platformFees',
              totalFees: { $add: ['$bookingFees', '$platformFees'] },
              ticketsSold: '$ticketsSold',
              salesCount: '$salesCount',
            },
          },
        },
      },
      { $addFields: { totalFees: { $add: ['$bookingFees', '$platformFees'] } } },
      // 3) attach event name
      { $lookup: { from: 'events', localField: '_id', foreignField: '_id', as: 'event' } },
      { $unwind: '$event' },
      { $addFields: { eventName: '$event.name' } },
      { $project: { event: 0 } },
      ...nameStage,
      // 4) one page of rows + grand totals over the whole filtered set
      {
        $facet: {
          rows: [{ $sort: { totalFees: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
          totals: [
            {
              $group: {
                _id: null,
                eventCount: { $sum: 1 },
                ticketsSold: { $sum: '$ticketsSold' },
                faceValue: { $sum: '$faceValue' },
                bookingFees: { $sum: '$bookingFees' },
                platformFees: { $sum: '$platformFees' },
                totalFees: { $sum: '$totalFees' },
              },
            },
          ],
        },
      },
    ]);

    const facet = agg[0] ?? { rows: [], totals: [] };
    const t = facet.totals[0] ?? EMPTY_TOTALS;

    const totals: FeeTotals = {
      eventCount: t.eventCount ?? 0,
      ticketsSold: t.ticketsSold ?? 0,
      faceValue: round2(t.faceValue ?? 0),
      bookingFees: round2(t.bookingFees ?? 0),
      platformFees: round2(t.platformFees ?? 0),
      totalFees: round2(t.totalFees ?? 0),
    };

    const events: FeeByEventRow[] = (facet.rows as any[]).map((r) => ({
      eventId: String(r._id),
      eventName: r.eventName,
      ticketsSold: r.ticketsSold ?? 0,
      faceValue: round2(r.faceValue ?? 0),
      bookingFees: round2(r.bookingFees ?? 0),
      platformFees: round2(r.platformFees ?? 0),
      totalFees: round2(r.totalFees ?? 0),
      byMethod: (r.byMethod as any[])
        .map((m) => ({
          method: m.method,
          bookingFees: round2(m.bookingFees ?? 0),
          platformFees: round2(m.platformFees ?? 0),
          totalFees: round2(m.totalFees ?? 0),
          ticketsSold: m.ticketsSold ?? 0,
          salesCount: m.salesCount ?? 0,
        }))
        .sort((a, b) => b.totalFees - a.totalFees),
    }));

    return {
      events,
      totals,
      pagination: { page, limit, total: totals.eventCount, totalPages: Math.ceil(totals.eventCount / limit) },
    };
  }
}
