// api/src/services/resellerReports.service.ts
//
// Actor-scoped reseller reports:
//   - reseller_hub_manager → scope:'hub', aggregated over their single hub
//   - reseller_admin       → scope:'reseller', aggregated over all hubs in their reseller
//
// All money rounded to 2dp via round2; ticketsSold is integer.
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ResellerReportRow {
  revenue: number;
  ticketsSold: number;
  commission: number;
}

export interface ResellerReport {
  scope: 'hub' | 'reseller';
  totals: ResellerReportRow;
  byEvent: Array<{ eventId: string } & ResellerReportRow>;
  byHub: Array<{ hubId: string } & ResellerReportRow>;
  byOperator: Array<{ operatorId: string } & ResellerReportRow>;
}

function mapRow(r: any): ResellerReportRow {
  return {
    revenue: round2(r.revenue ?? 0),
    ticketsSold: r.ticketsSold ?? 0,
    commission: round2(r.commission ?? 0),
  };
}

/**
 * Runs totals + byEvent + byHub + byOperator aggregations from a single base match.
 */
async function _aggregate(match: Record<string, unknown>): Promise<{
  totals: ResellerReportRow;
  byEvent: Array<{ eventId: string } & ResellerReportRow>;
  byHub: Array<{ hubId: string } & ResellerReportRow>;
  byOperator: Array<{ operatorId: string } & ResellerReportRow>;
}> {
  const groupFields = {
    revenue: { $sum: '$totalAmount' },
    ticketsSold: { $sum: '$quantity' },
    commission: { $sum: '$resellerCommissionAmount' },
  };

  const [totalsRows, byEventRows, byHubRows, byOperatorRows] = await Promise.all([
    TicketSale.aggregate([
      { $match: match },
      { $group: { _id: null, ...groupFields } },
    ]),
    TicketSale.aggregate([
      { $match: match },
      { $group: { _id: '$eventId', ...groupFields } },
    ]),
    TicketSale.aggregate([
      { $match: match },
      { $group: { _id: '$hubId', ...groupFields } },
    ]),
    TicketSale.aggregate([
      { $match: { ...match, soldByType: 'ResellerOperator' } },
      { $group: { _id: '$soldBy', ...groupFields } },
    ]),
  ]);

  const totals = totalsRows[0] ? mapRow(totalsRows[0]) : { revenue: 0, ticketsSold: 0, commission: 0 };

  const byEvent = byEventRows.map((r: any) => ({ eventId: String(r._id), ...mapRow(r) }));
  const byHub = byHubRows.map((r: any) => ({ hubId: String(r._id), ...mapRow(r) }));
  const byOperator = byOperatorRows.map((r: any) => ({ operatorId: String(r._id), ...mapRow(r) }));

  return { totals, byEvent, byHub, byOperator };
}

export class ResellerReportsService {
  /** Hub-scoped report for a reseller_hub_manager. */
  static async forHub(hubId: string, from: Date, to: Date): Promise<ResellerReport> {
    const match: Record<string, unknown> = {
      hubId: new mongoose.Types.ObjectId(hubId),
      paymentStatus: 'completed',
      soldAt: { $gte: from, $lte: to },
    };
    const { totals, byEvent, byHub, byOperator } = await _aggregate(match);
    return { scope: 'hub', totals, byEvent, byHub, byOperator };
  }

  /** Reseller-wide report for a reseller_admin. */
  static async forReseller(resellerId: string, from: Date, to: Date): Promise<ResellerReport> {
    const match: Record<string, unknown> = {
      resellerId: new mongoose.Types.ObjectId(resellerId),
      paymentStatus: 'completed',
      soldAt: { $gte: from, $lte: to },
    };
    const { totals, byEvent, byHub, byOperator } = await _aggregate(match);
    return { scope: 'reseller', totals, byEvent, byHub, byOperator };
  }
}
