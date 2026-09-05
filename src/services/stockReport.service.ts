// api/src/services/stockReport.service.ts
import mongoose from 'mongoose';
import { ProductStock } from '@models/productStock.model';
import { Product } from '@models/product.model';
import { Merchant } from '@models/merchant.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { StockMovementReason } from '@interfaces/stock.interface';
import { HEX24 } from '@utils/controllerHelpers.util';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Eswatini is UTC+2; all Carrot events are Eswatini today. Named so peak-time
 *  bucketing (dashboard) is a one-line change when Carrot goes multi-region. */
export const EVENT_TZ_OFFSET = '+02:00';
/** Predicted stock-out lookback window (minutes), computed at read time. */
export const PREDICT_WINDOW_MIN = 60;

type StockStatus = 'IN_STOCK' | 'LOW' | 'SOLD_OUT';
function statusOf(onHand: number, threshold: number | null): StockStatus {
  if (onHand <= 0) return 'SOLD_OUT';
  if (threshold != null && threshold > 0 && onHand <= threshold) return 'LOW';
  return 'IN_STOCK';
}

/**
 * The organiser's stock read-model (design 2026-08-13, Slice 4). Every figure
 * is a read-time aggregation over the Slice 1-3 records — no writes, no new
 * bookkeeping. The caller has already loaded + ownership-checked the event.
 */
export class StockReportService {
  /** Live stock board — per bar-product status + per-product aggregate. */
  static async board(eventId: string) {
    const eid = oid(eventId);
    const [rows, products, merchants, sales] = await Promise.all([
      ProductStock.find({ eventId: eid }).lean(),
      Product.find({ eventId: eid }).select('name category').lean(),
      Merchant.find({ eventId: eid }).select('name').lean(),
      // What actually left the shelf and what it brought in, from the CHARGES
      // rather than the stock journal: the journal knows units, only the charge
      // knows the money. Un-itemised charges carry no product lines and so
      // contribute to neither — see `itemisedSplit` on the dashboard for how
      // much revenue that is.
      MerchantCharge.aggregate([
        { $match: { eventId: eid } },
        { $unwind: '$items' },
        {
          $group: {
            _id: { merchantId: '$merchantId', productId: '$items.productId' },
            unitsSold: { $sum: '$items.qty' },
            revenue: { $sum: '$items.lineTotal' },
          },
        },
      ]),
    ]);
    const productName = new Map(products.map((p: any) => [String(p._id), p.name]));
    const productCat = new Map(products.map((p: any) => [String(p._id), p.category]));
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));
    const soldByBar = new Map<string, { unitsSold: number; revenue: number }>(
      sales.map((s: any) => [
        `${String(s._id.merchantId)}|${String(s._id.productId)}`,
        { unitsSold: s.unitsSold, revenue: s.revenue },
      ]),
    );

    const perBar = rows.map((r: any) => {
      const threshold = r.lowStockThreshold ?? null;
      const sold = soldByBar.get(`${String(r.merchantId)}|${String(r.productId)}`) ?? { unitsSold: 0, revenue: 0 };
      return {
        merchantId: String(r.merchantId),
        merchantName: merchantName.get(String(r.merchantId)) || 'Unknown bar',
        productId: String(r.productId),
        productName: productName.get(String(r.productId)) || 'Unknown product',
        category: productCat.get(String(r.productId)) || 'other',
        onHand: r.onHand,
        unitsSold: sold.unitsSold,
        revenue: sold.revenue,
        lowStockThreshold: threshold,
        status: statusOf(r.onHand, threshold),
      };
    }).sort((a, b) => a.productName.localeCompare(b.productName) || a.merchantName.localeCompare(b.merchantName));

    // Aggregate one product across all its bars.
    const agg = new Map<string, { totalOnHand: number; unitsSold: number; revenue: number; anyLow: boolean }>();
    for (const r of perBar) {
      const a = agg.get(r.productId) || { totalOnHand: 0, unitsSold: 0, revenue: 0, anyLow: false };
      a.totalOnHand += r.onHand;
      a.unitsSold += r.unitsSold;
      a.revenue += r.revenue;
      if (r.status === 'LOW') a.anyLow = true;
      agg.set(r.productId, a);
    }
    // A product sold at a stall that never carried stock has no perBar row, so
    // it would vanish from the board entirely — the sales still happened and
    // the organizer must see them.
    for (const [key, s] of soldByBar) {
      const productId = key.split('|')[1] ?? '';
      if (agg.has(productId)) continue;
      agg.set(productId, { totalOnHand: 0, unitsSold: s.unitsSold, revenue: s.revenue, anyLow: false });
    }
    const byProduct = [...agg.entries()].map(([productId, a]) => ({
      productId,
      productName: productName.get(productId) || 'Unknown product',
      category: productCat.get(productId) || 'other',
      totalOnHand: a.totalOnHand,
      unitsSold: a.unitsSold,
      revenue: a.revenue,
      status: (a.totalOnHand <= 0 ? 'SOLD_OUT' : (a.anyLow ? 'LOW' : 'IN_STOCK')) as StockStatus,
    })).sort((a, b) => a.productName.localeCompare(b.productName));

    return { perBar, byProduct };
  }

  /**
   * Opening → Added → Transfers → Sold → Expected → Physical → Variance, per
   * bar-product, rolled up per product + a grand total. `opening` = an explicit
   * opening-count if present else pre-doors receives; `added` = post-doors
   * receives; `expectedClosing` = the authoritative onHand; physical + variance
   * come from the latest CLOSING count. Derived from the journal by reason.
   *
   * An opening COUNT is the baseline its row reconciles against, so for that
   * bar-product only movements AFTER the count are folded in: everything
   * before it — the pre-doors receives, the count's own adjustment, a test
   * sale — is already inside the counted figure, and adding it again would
   * apply those units twice (phantom shrinkage on a bar that is exactly
   * right). Receives after the count are `added` even when pre-doors.
   */
  static async reconciliation(eventId: string, startTime: Date) {
    const eid = oid(eventId);
    const key = (m: any, p: any) => `${m}|${p}`;

    // Latest opening + closing count per (merchant, product). Fetched FIRST:
    // the opening counts decide what the movement aggregations may count.
    const counts = await StockCount.aggregate([
      { $match: { eventId: eid, phase: { $in: ['opening', 'closing'] } } },
      { $sort: { at: -1 } },
      { $group: { _id: { merchantId: '$merchantId', productId: '$productId', phase: '$phase' }, countId: { $first: '$_id' }, at: { $first: '$at' }, countedOnHand: { $first: '$countedOnHand' }, variance: { $first: '$variance' } } },
    ]);
    const openings = counts.filter((c: any) => c._id.phase === 'opening');
    const openingKeys = new Set(openings.map((c: any) => key(c._id.merchantId, c._id.productId)));
    // Movement scope: a bar-product WITH an opening count contributes only the
    // movements at/after it, minus the count's own adjustment (which shares
    // its timestamp); every other bar-product contributes its whole journal.
    const scope = openings.length === 0 ? {} : {
      $or: [
        ...openings.map((c: any) => ({
          merchantId: c._id.merchantId, productId: c._id.productId,
          at: { $gte: c.at }, $nor: [{ refType: 'stock_count', refId: String(c.countId) }],
        })),
        { $nor: openings.map((c: any) => ({ merchantId: c._id.merchantId, productId: c._id.productId })) },
      ],
    };

    const [byReason, receiveSplit, stockRows, products, merchants] = await Promise.all([
      StockMovement.aggregate([
        { $match: { eventId: eid, ...scope } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId', reason: '$reason' }, qty: { $sum: '$delta' } } },
      ]),
      StockMovement.aggregate([
        { $match: { eventId: eid, reason: StockMovementReason.RECEIVE, ...scope } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId', pre: { $lt: ['$at', startTime] } }, qty: { $sum: '$delta' } } },
      ]),
      ProductStock.find({ eventId: eid }).lean(),
      Product.find({ eventId: eid }).select('name').lean(),
      Merchant.find({ eventId: eid }).select('name').lean(),
    ]);

    const productName = new Map(products.map((p: any) => [String(p._id), p.name]));
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));

    const rowByKey = new Map<string, any>();
    const ensure = (merchantId: string, productId: string) => {
      const k = key(merchantId, productId);
      let r = rowByKey.get(k);
      if (!r) {
        r = {
          merchantId, merchantName: merchantName.get(merchantId) || 'Unknown bar',
          productId, productName: productName.get(productId) || 'Unknown product',
          opening: 0, added: 0, transferIn: 0, transferOut: 0, sold: 0, countAdjust: 0, spoilage: 0, manual: 0,
          expectedClosing: 0, physicalCount: null, variance: null,
        };
        rowByKey.set(k, r);
      }
      return r;
    };
    for (const s of stockRows) { const r = ensure(String(s.merchantId), String(s.productId)); r.expectedClosing = s.onHand; }

    // Fold movement sums by reason (transfer_out/sale/spoilage deltas are negative -> report as positive magnitudes).
    for (const g of byReason) {
      const r = ensure(String(g._id.merchantId), String(g._id.productId));
      switch (g._id.reason) {
        case StockMovementReason.TRANSFER_IN: r.transferIn += g.qty; break;
        case StockMovementReason.TRANSFER_OUT: r.transferOut += -g.qty; break;
        case StockMovementReason.SALE: r.sold += -g.qty; break;
        case StockMovementReason.COUNT_ADJUST: r.countAdjust += g.qty; break;
        case StockMovementReason.SPOILAGE: r.spoilage += -g.qty; break;
        case StockMovementReason.MANUAL: r.manual += g.qty; break;
        default: break; // receive handled by the split below
      }
    }
    // Opening (pre-doors receive) vs Added (post-doors receive) — unless an
    // opening COUNT is the baseline, in which case any receive that survived
    // the scope above came after the count and is an addition to it.
    for (const g of receiveSplit) {
      const r = ensure(String(g._id.merchantId), String(g._id.productId));
      if (g._id.pre && !openingKeys.has(key(g._id.merchantId, g._id.productId))) r.opening += g.qty; else r.added += g.qty;
    }
    // An explicit opening count overrides the pre-doors-receive baseline; closing supplies physical + variance.
    for (const c of counts) {
      const r = ensure(String(c._id.merchantId), String(c._id.productId));
      if (c._id.phase === 'opening') r.opening = c.countedOnHand;
      else { r.physicalCount = c.countedOnHand; r.variance = c.variance; }
    }

    const perBar = [...rowByKey.values()].sort((a, b) => a.productName.localeCompare(b.productName) || a.merchantName.localeCompare(b.merchantName));

    const NUM = ['opening', 'added', 'transferIn', 'transferOut', 'sold', 'countAdjust', 'spoilage', 'manual', 'expectedClosing'] as const;
    const blank = () => Object.fromEntries(NUM.map((k) => [k, 0])) as Record<typeof NUM[number], number>;
    // physicalCount/variance stay null in a rollup until at least one contributing
    // bar has a CLOSING count — a rollup of "0" would read as "counted zero units"
    // rather than "not yet counted", which is a materially different signal.
    const byProdMap = new Map<string, any>();
    const total: any = { ...blank(), physicalCount: null, variance: null };
    for (const r of perBar) {
      const agg = byProdMap.get(r.productId) || { productId: r.productId, productName: r.productName, ...blank(), physicalCount: null, variance: null };
      for (const k of NUM) { agg[k] += r[k]; total[k] += r[k]; }
      if (r.physicalCount != null) { agg.physicalCount = (agg.physicalCount ?? 0) + r.physicalCount; total.physicalCount = (total.physicalCount ?? 0) + r.physicalCount; }
      if (r.variance != null) { agg.variance = (agg.variance ?? 0) + r.variance; total.variance = (total.variance ?? 0) + r.variance; }
      byProdMap.set(r.productId, agg);
    }
    const byProduct = [...byProdMap.values()].sort((a, b) => a.productName.localeCompare(b.productName));
    return { perBar, byProduct, total };
  }

  /** Event Stock Dashboard — revenue by product, best-sellers, sales by bar +
   *  employee, itemised split, peak times, variances, predicted stock-out.
   *  All read-time; predicted stock-out is computed against "now", never stored. */
  static async dashboard(eventId: string) {
    const eid = oid(eventId);
    const now = new Date();
    const windowStart = new Date(now.getTime() - PREDICT_WINDOW_MIN * 60_000);

    const [productRevenue, byBar, byEmployee, split, peak, closingCounts, stockRows, saleWindow, products, merchants] = await Promise.all([
      MerchantCharge.aggregate([
        { $match: { eventId: eid } }, { $unwind: '$items' },
        { $group: { _id: '$items.productId', revenue: { $sum: '$items.lineTotal' }, units: { $sum: '$items.qty' } } },
      ]),
      MerchantCharge.aggregate([
        { $match: { eventId: eid } },
        { $group: { _id: '$merchantId', gross: { $sum: '$amount' }, fee: { $sum: '$fee' }, net: { $sum: '$netAmount' }, count: { $sum: 1 } } },
      ]),
      MerchantCharge.aggregate([
        { $match: { eventId: eid } },
        { $group: { _id: { $ifNull: ['$staffName', null] }, gross: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      MerchantCharge.aggregate([
        { $match: { eventId: eid } },
        { $group: { _id: { $gt: [{ $size: { $ifNull: ['$items', []] } }, 0] }, gross: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      StockMovement.aggregate([
        { $match: { eventId: eid, reason: StockMovementReason.SALE } },
        { $group: { _id: { $hour: { date: '$at', timezone: EVENT_TZ_OFFSET } }, units: { $sum: { $abs: '$delta' } } } },
      ]),
      StockCount.aggregate([
        { $match: { eventId: eid, phase: 'closing' } }, { $sort: { at: -1 } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId' }, variance: { $first: '$variance' } } },
      ]),
      ProductStock.find({ eventId: eid }).lean(),
      StockMovement.aggregate([
        { $match: { eventId: eid, reason: StockMovementReason.SALE, at: { $gte: windowStart } } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId' }, units: { $sum: { $abs: '$delta' } } } },
      ]),
      Product.find({ eventId: eid }).select('name').lean(),
      Merchant.find({ eventId: eid }).select('name').lean(),
    ]);

    const productName = new Map(products.map((p: any) => [String(p._id), p.name]));
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));

    const revenueByProduct = productRevenue
      .map((r: any) => ({ productId: String(r._id), productName: productName.get(String(r._id)) || 'Unknown product', revenue: r.revenue, units: r.units }))
      .sort((a: any, b: any) => b.revenue - a.revenue);
    const bestSellers = [...revenueByProduct].sort((a, b) => b.units - a.units).slice(0, 10);

    const salesByBar = byBar
      .map((r: any) => ({ merchantId: String(r._id), merchantName: merchantName.get(String(r._id)) || 'Unknown bar', gross: r.gross, fee: r.fee, net: r.net, count: r.count }))
      .sort((a: any, b: any) => b.gross - a.gross);

    const salesByEmployee = byEmployee
      .map((r: any) => ({ staffName: (r._id ?? null) as string | null, label: r._id || 'Unattributed', gross: r.gross, count: r.count }))
      .sort((a: any, b: any) => b.gross - a.gross);

    const itemisedSplit = { itemised: { gross: 0, count: 0 }, unitemised: { gross: 0, count: 0 } };
    for (const s of split) {
      const bucket = s._id ? itemisedSplit.itemised : itemisedSplit.unitemised;
      bucket.gross += s.gross;
      bucket.count += s.count;
    }

    const peakByHour = new Map<number, number>(peak.map((p: any) => [p._id, p.units]));
    const peakTimes = Array.from({ length: 24 }, (_, hour) => ({ hour, units: peakByHour.get(hour) || 0 }));

    const variances = closingCounts
      .filter((c: any) => c.variance !== 0)
      .map((c: any) => ({
        merchantId: String(c._id.merchantId), merchantName: merchantName.get(String(c._id.merchantId)) || 'Unknown bar',
        productId: String(c._id.productId), productName: productName.get(String(c._id.productId)) || 'Unknown product', variance: c.variance,
      }))
      .sort((a: any, b: any) => a.variance - b.variance);
    const totalShrinkageUnits = variances.reduce((s: number, v: any) => s + Math.min(v.variance, 0), 0);

    const soldByKey = new Map(saleWindow.map((s: any) => [`${s._id.merchantId}|${s._id.productId}`, s.units]));
    let noRecentSales = 0;
    const predictedStockOut = stockRows
      .filter((s: any) => s.onHand > 0)
      .map((s: any) => {
        const units = (soldByKey.get(`${s.merchantId}|${s.productId}`) as number) || 0;
        const ratePerMin = units / PREDICT_WINDOW_MIN;
        const minutesToStockOut = ratePerMin > 0 ? s.onHand / ratePerMin : null;
        if (minutesToStockOut == null) noRecentSales++;
        return {
          merchantId: String(s.merchantId), merchantName: merchantName.get(String(s.merchantId)) || 'Unknown bar',
          productId: String(s.productId), productName: productName.get(String(s.productId)) || 'Unknown product',
          onHand: s.onHand, ratePerMin, minutesToStockOut,
        };
      })
      .filter((r: any) => r.minutesToStockOut != null)
      .sort((a: any, b: any) => (a.minutesToStockOut as number) - (b.minutesToStockOut as number));

    return { revenueByProduct, bestSellers, salesByBar, salesByEmployee, itemisedSplit, peakTimes, variances, totalShrinkageUnits, predictedStockOut, noRecentSales };
  }

  /** The append-only stock journal for the event, newest first, cursor-paged on
   *  _id (movements are insert-ordered by the sole writer). Optional product/bar
   *  filters. Product + bar names joined per page. */
  static async movements(params: { eventId: string; productId?: string; merchantId?: string; cursor?: string; limit?: number }) {
    const { eventId, productId, merchantId, cursor } = params;
    const hex24 = /^[0-9a-fA-F]{24}$/;
    // NaN (from a non-numeric ?limit) is not caught by ?? — guard it explicitly so
    // a malformed param defaults cleanly instead of reaching .limit(NaN).
    const limit = Math.min(Math.max(Number.isFinite(params.limit as number) ? (params.limit as number) : 50, 1), 200);
    const q: any = { eventId: oid(eventId) };
    // Ignore malformed id filters rather than letting oid() throw a 500 (defensive;
    // the controller also rejects them with a 400).
    if (productId && hex24.test(productId)) q.productId = oid(productId);
    if (merchantId && hex24.test(merchantId)) q.merchantId = oid(merchantId);
    if (cursor && hex24.test(cursor)) q._id = { $lt: oid(cursor) };

    const docs = await StockMovement.find(q).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const productIds = [...new Set(page.map((d: any) => String(d.productId)))];
    const merchantIds = [...new Set(page.map((d: any) => String(d.merchantId)))];
    // `by` is a free-form string: an ObjectId for Merchant-written rows, but a
    // vendorId or the literal 'platform' for Organizer/Platform rows — guard
    // with HEX24 so those never reach an ObjectId cast and 500 the endpoint.
    const operatorIds = [...new Set(
      page
        .filter((d: any) => d.byType === 'Merchant' && HEX24.test(String(d.by)))
        .map((d: any) => String(d.by)),
    )];
    const [prods, merchs, ops] = await Promise.all([
      Product.find({ _id: { $in: productIds.map(oid) } }).select('name').lean(),
      Merchant.find({ _id: { $in: merchantIds.map(oid) } }).select('name').lean(),
      operatorIds.length
        ? MerchantOperator.find({ _id: { $in: operatorIds.map(oid) } }).select('fullName').lean()
        : Promise.resolve([] as any[]),
    ]);
    const productName = new Map(prods.map((p: any) => [String(p._id), p.name]));
    const merchantName = new Map(merchs.map((m: any) => [String(m._id), m.name]));
    const operatorName = new Map(ops.map((o: any) => [String(o._id), o.fullName]));

    const movements = page.map((d: any) => ({
      id: String(d._id), at: d.at,
      merchantId: String(d.merchantId), merchantName: merchantName.get(String(d.merchantId)) || 'Unknown bar',
      productId: String(d.productId), productName: productName.get(String(d.productId)) || 'Unknown product',
      delta: d.delta, reason: d.reason, balanceAfter: d.balanceAfter,
      refType: d.refType ?? null, refId: d.refId ?? null,
      byType: d.byType, by: d.by,
      // Who actually did it. Organizer-written rows keep byName null — their
      // `by` is a vendorId, not a person, and inventing a name for it would be
      // worse than showing none.
      byName: d.byType === 'Merchant' ? (operatorName.get(String(d.by)) ?? 'Unknown operator') : null,
      note: d.note ?? null,
    }));
    const last = page[page.length - 1];
    return { movements, nextCursor: hasMore && last ? String(last._id) : null, hasMore };
  }
}
