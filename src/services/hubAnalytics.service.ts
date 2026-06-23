// api/src/services/hubAnalytics.service.ts
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { ResellerOperator } from '@models/resellerOperator.model';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface HubOperatorStat {
  operatorId: string;
  fullName: string;
  loginCode: string;
  salesCount: number;
  revenue: number;
  ticketsSold: number;
}

export interface HubAnalytics {
  hubId: string;
  revenue: number;
  ticketsSold: number;
  salesCount: number;
  operatorsCount: number;
  byOperator: HubOperatorStat[];
}

export class HubAnalyticsService {
  static async getHubAnalytics(hubId: string, from?: Date, to?: Date): Promise<HubAnalytics> {
    const hubOid = new mongoose.Types.ObjectId(hubId);
    const match: Record<string, unknown> = { hubId: hubOid, paymentStatus: 'completed' };
    if (from && to) match['soldAt'] = { $gte: from, $lte: to };

    const [totalsRow] = await TicketSale.aggregate([
      { $match: match },
      { $group: { _id: null, revenue: { $sum: '$totalAmount' }, ticketsSold: { $sum: '$quantity' }, salesCount: { $sum: 1 } } },
    ]);

    const perOp = await TicketSale.aggregate([
      { $match: { ...match, soldByType: 'ResellerOperator' } },
      { $group: { _id: '$soldBy', revenue: { $sum: '$totalAmount' }, ticketsSold: { $sum: '$quantity' }, salesCount: { $sum: 1 } } },
    ]);
    const statByOp = new Map<string, { revenue: number; ticketsSold: number; salesCount: number }>();
    for (const r of perOp) {
      statByOp.set(String(r._id), { revenue: r.revenue, ticketsSold: r.ticketsSold, salesCount: r.salesCount });
    }

    const operators = await ResellerOperator.find({ hubId: hubOid }).select('fullName loginCode');
    const byOperator: HubOperatorStat[] = operators.map((op) => {
      const s = statByOp.get(String(op._id)) ?? { revenue: 0, ticketsSold: 0, salesCount: 0 };
      return {
        operatorId: String(op._id),
        fullName: op.fullName,
        loginCode: op.loginCode,
        salesCount: s.salesCount,
        revenue: round2(s.revenue),
        ticketsSold: s.ticketsSold,
      };
    });

    return {
      hubId,
      revenue: round2(totalsRow?.revenue ?? 0),
      ticketsSold: totalsRow?.ticketsSold ?? 0,
      salesCount: totalsRow?.salesCount ?? 0,
      operatorsCount: operators.length,
      byOperator,
    };
  }
}
