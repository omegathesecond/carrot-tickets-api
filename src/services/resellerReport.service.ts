// api/src/services/resellerReport.service.ts
//
// Manager/admin reporting over reseller sales. Scope isolation:
//   - reseller_admin       → all hubs in their reseller
//   - reseller_hub_manager → only their own hub
// Operators use /reseller/sales (their own sales) instead.
import mongoose from 'mongoose';
import { TicketSale } from '@models/ticketSale.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { ResellerHub } from '@models/resellerHub.model';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ManagerSaleRow {
  id: string;
  saleId: string;
  eventName: string;
  operatorName: string;
  hubName: string;
  quantity: number;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  customerName: string;
  soldAt: string;
}

export interface ReportScope {
  resellerId: string;
  role: string;
  hubId?: string;
}

/** Base Mongo filter enforcing the actor's scope. Hub managers are pinned to
 *  their own hub; admins may optionally narrow to one hub via `extraHubId`. */
function scopeMatch(scope: ReportScope, extraHubId?: string): Record<string, unknown> {
  const m: Record<string, unknown> = {
    resellerId: new mongoose.Types.ObjectId(scope.resellerId),
    soldByType: 'ResellerOperator',
  };
  if (scope.role === 'reseller_hub_manager' && scope.hubId) {
    m['hubId'] = new mongoose.Types.ObjectId(scope.hubId);
  } else if (extraHubId) {
    m['hubId'] = new mongoose.Types.ObjectId(extraHubId);
  }
  return m;
}

function dateRange(from?: Date, to?: Date): Record<string, Date> | undefined {
  if (!from && !to) return undefined;
  const r: Record<string, Date> = {};
  if (from) r['$gte'] = from;
  if (to) r['$lte'] = to;
  return r;
}

export class ResellerReportService {
  /** Individual sale rows across the actor's scope, newest first. */
  static async listSales(params: {
    scope: ReportScope;
    page?: number;
    limit?: number;
    from?: Date;
    to?: Date;
    hubId?: string;
    operatorId?: string;
    paymentMethod?: string;
  }): Promise<{ sales: ManagerSaleRow[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));

    const filter = scopeMatch(params.scope, params.hubId);
    if (params.operatorId) filter['soldBy'] = new mongoose.Types.ObjectId(params.operatorId);
    if (params.paymentMethod) filter['paymentMethod'] = params.paymentMethod;
    const range = dateRange(params.from, params.to);
    if (range) filter['soldAt'] = range;

    const [rows, total] = await Promise.all([
      TicketSale.find(filter)
        .populate('eventId', 'name')
        .populate({ path: 'soldBy', select: 'fullName', model: 'ResellerOperator' })
        .populate({ path: 'hubId', select: 'name', model: 'ResellerHub' })
        .sort({ soldAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TicketSale.countDocuments(filter),
    ]);

    const sales: ManagerSaleRow[] = rows.map((s: any) => ({
      id: String(s._id),
      saleId: s.saleId ?? '',
      eventName: s.eventId?.name ?? '',
      operatorName: s.soldBy?.fullName ?? '',
      hubName: s.hubId?.name ?? '',
      quantity: s.quantity ?? 0,
      totalAmount: round2(s.totalAmount ?? 0),
      paymentMethod: s.paymentMethod ?? '',
      paymentStatus: s.paymentStatus ?? '',
      customerName: s.customerName ?? '',
      soldAt: (s.soldAt ?? s.createdAt) instanceof Date
        ? (s.soldAt ?? s.createdAt).toISOString()
        : String(s.soldAt ?? ''),
    }));
    return { sales, total, page, limit };
  }

  /** Aggregated report (completed sales only) for the actor's scope. */
  static async summary(params: {
    scope: ReportScope;
    from?: Date;
    to?: Date;
    hubId?: string;
  }): Promise<{
    totals: { revenue: number; tickets: number; salesCount: number };
    byMethod: Array<{ method: string; revenue: number; tickets: number; count: number }>;
    byDay: Array<{ date: string; revenue: number; tickets: number; count: number }>;
    byOperator: Array<{ operatorId: string; fullName: string; revenue: number; tickets: number; count: number }>;
    byHub: Array<{ hubId: string; name: string; revenue: number; tickets: number; count: number }>;
  }> {
    const match = scopeMatch(params.scope, params.hubId);
    match['paymentStatus'] = 'completed';
    const range = dateRange(params.from, params.to);
    if (range) match['soldAt'] = range;

    const rows: any[] = await TicketSale.find(match)
      .select('totalAmount quantity paymentMethod soldAt soldBy hubId')
      .lean();

    let revenue = 0;
    let tickets = 0;
    const acc = () => ({ revenue: 0, tickets: 0, count: 0 });
    const byMethod = new Map<string, ReturnType<typeof acc>>();
    const byDay = new Map<string, ReturnType<typeof acc>>();
    const byOp = new Map<string, ReturnType<typeof acc>>();
    const byHub = new Map<string, ReturnType<typeof acc>>();

    const bump = (map: Map<string, ReturnType<typeof acc>>, key: string, amt: number, qty: number) => {
      const v = map.get(key) ?? acc();
      v.revenue += amt;
      v.tickets += qty;
      v.count += 1;
      map.set(key, v);
    };

    for (const s of rows) {
      const amt = s.totalAmount ?? 0;
      const qty = s.quantity ?? 0;
      revenue += amt;
      tickets += qty;
      bump(byMethod, s.paymentMethod ?? 'unknown', amt, qty);
      const day = (s.soldAt instanceof Date ? s.soldAt : new Date(s.soldAt))
        .toISOString()
        .slice(0, 10);
      bump(byDay, day, amt, qty);
      if (s.soldBy) bump(byOp, String(s.soldBy), amt, qty);
      if (s.hubId) bump(byHub, String(s.hubId), amt, qty);
    }

    const opIds = [...byOp.keys()];
    const operators = opIds.length
      ? await ResellerOperator.find({ _id: { $in: opIds } }).select('fullName').lean()
      : [];
    const opName = new Map(operators.map((o: any) => [String(o._id), o.fullName as string]));

    const hubIds = [...byHub.keys()];
    const hubs = hubIds.length
      ? await ResellerHub.find({ _id: { $in: hubIds } }).select('name').lean()
      : [];
    const hubName = new Map(hubs.map((h: any) => [String(h._id), h.name as string]));

    return {
      totals: { revenue: round2(revenue), tickets, salesCount: rows.length },
      byMethod: [...byMethod.entries()].map(([method, v]) => ({
        method,
        revenue: round2(v.revenue),
        tickets: v.tickets,
        count: v.count,
      })),
      byDay: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, revenue: round2(v.revenue), tickets: v.tickets, count: v.count })),
      byOperator: [...byOp.entries()]
        .map(([id, v]) => ({
          operatorId: id,
          fullName: opName.get(id) ?? '—',
          revenue: round2(v.revenue),
          tickets: v.tickets,
          count: v.count,
        }))
        .sort((a, b) => b.revenue - a.revenue),
      byHub: [...byHub.entries()]
        .map(([id, v]) => ({
          hubId: id,
          name: hubName.get(id) ?? '—',
          revenue: round2(v.revenue),
          tickets: v.tickets,
          count: v.count,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  }
}
