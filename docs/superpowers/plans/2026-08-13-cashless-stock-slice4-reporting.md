# Cashless Stock — Slice 4: Reporting & Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the organiser's four read-only stock report surfaces — live board, reconciliation, event dashboard, and the movements audit journal — as `GET` endpoints derived entirely from the Slice 1-3 records (no new writes, no new models).

**Architecture:** One new `StockReportService` (pure read aggregations over `ProductStock`/`StockMovement`/`MerchantCharge`/`StockCount`) + a `StockReportController` that reuses the existing `loadOwnedCashlessEvent` ownership guard (exported from `organizerCashless.controller.ts`). Four routes appended to the cashless reporting block in `tickets.route.ts`, all gated by `VIEW_REVENUE`.

**Tech Stack:** Node + TS, Express, Mongoose (replica set for the ledger harness), Jest + `mongodb-memory-server`, supertest. Aliases `@models/* @services/* @interfaces/* @controllers/* @utils/*`.

**Spec:** `docs/superpowers/specs/2026-08-13-cashless-stock-slice4-reporting-design.md`

## Global Constraints

- **Base branch:** `feat/cashless-stock-reporting` off `feat/cashless-cashier` (Slices 1+2+3 merged), fresh worktree `api-stock-reporting-wt`. Merge onto the cashless line, **not** `main`.
- **Read-only slice:** no writes, no new models, no new schema fields, no new indexes. Every figure is a read-time aggregation. The money ledger and stock journal are byte-identical.
- **The itemised classification landmine:** `MerchantCharge.items` is `default:undefined`, so amount-only charges store **no** `items` field. Classify itemised-vs-un-itemised by **`items.0` existence** — `{ $gt: [ { $size: { $ifNull: ['$items', []] } }, 0 ] }` — NEVER by whether the `items` key exists. Getting this wrong misclassifies every amount-only sale.
- **Permission + ownership:** all four endpoints use `requireTicketsPermission(TicketsPermission.VIEW_REVENUE)` + the shared `loadOwnedCashlessEvent(req,res,eventId)` guard (own event only; non-owner → 403; non-cashless → 400; unknown → 404).
- **Doors-open marker = `event.startTime`** (authoritative UTC instant). Peak-hour bucketing uses `EVENT_TZ_OFFSET = '+02:00'` (Eswatini). Never format a clock off `eventDate` (date-only midnight-UTC marker).
- **Fail loudly:** on an aggregation error the endpoint 500s with the message (no fabricated empty "success"), per the workspace no-silent-fallback rule.
- **Money is integer ZAR cents; stock is integer base units.**

---

### Task 1: `StockReportService.board` + controller/route scaffold (live stock board)

**Files:**
- Create: `src/services/stockReport.service.ts`
- Create: `src/controllers/stockReport.controller.ts`
- Modify: `src/controllers/organizerCashless.controller.ts` (add `export` to `loadOwnedCashlessEvent`)
- Modify: `src/routes/tickets.route.ts` (import controller + mount `/stock/board`)
- Test: `src/services/__tests__/stockReport.board.test.ts`, `src/routes/__tests__/stockReportBoard.route.test.ts`

**Interfaces:**
- Consumes: `ProductStock`, `Product`, `Merchant` models; `loadOwnedCashlessEvent(req,res,eventId): Promise<event|null>`.
- Produces:
  - `StockReportService.board(eventId: string): Promise<{ perBar: BoardRow[]; byProduct: ByProductRow[] }>` where
    `BoardRow = { merchantId, merchantName, productId, productName, category, onHand, lowStockThreshold: number|null, status: 'IN_STOCK'|'LOW'|'SOLD_OUT' }`
    and `ByProductRow = { productId, productName, category, totalOnHand, status }`.
  - `StockReportController.board(req,res)`; `GET /api/tickets/events/:eventId/stock/board`.
  - `loadOwnedCashlessEvent` becomes an exported symbol.

- [ ] **Step 1: Export the ownership guard**

In `src/controllers/organizerCashless.controller.ts`, change the guard's declaration from `async function loadOwnedCashlessEvent(` to `export async function loadOwnedCashlessEvent(`. No other change.

- [ ] **Step 2: Write the failing board service test**

```typescript
// src/services/__tests__/stockReport.board.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';

const eventId = new mongoose.Types.ObjectId();

async function bar(name: string) { return Merchant.create({ name, eventId, status: 'active', pin: '0000' } as any); }
async function prod(name: string, category = 'beer') { return Product.create({ eventId, name, category, price: 2500 } as any); }
async function stock(merchantId: any, productId: any, onHand: number, lowStockThreshold?: number) {
  return ProductStock.create({ eventId, merchantId, productId, onHand, ...(lowStockThreshold != null ? { lowStockThreshold } : {}) } as any);
}

describe('StockReportService.board', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('reports status per bar and aggregates per product', async () => {
    const b1 = await bar('Bar 1'); const b2 = await bar('Bar 2');
    const castle = await prod('Castle Lite'); const savanna = await prod('Savanna');
    await stock(b1._id, castle._id, 63);              // IN_STOCK
    await stock(b2._id, castle._id, 12, 20);          // LOW (12 <= 20)
    await stock(b1._id, savanna._id, 0, 5);           // SOLD_OUT

    const { perBar, byProduct } = await StockReportService.board(String(eventId));

    const castleB2 = perBar.find(r => r.merchantName === 'Bar 2' && r.productName === 'Castle Lite')!;
    expect(castleB2.status).toBe('LOW');
    const savB1 = perBar.find(r => r.productName === 'Savanna')!;
    expect(savB1.status).toBe('SOLD_OUT');

    const castleAgg = byProduct.find(p => p.productName === 'Castle Lite')!;
    expect(castleAgg.totalOnHand).toBe(75);           // 63 + 12
    const savAgg = byProduct.find(p => p.productName === 'Savanna')!;
    expect(savAgg.status).toBe('SOLD_OUT');           // total 0
  });

  it('never reads LOW when threshold is unset', async () => {
    const b1 = await bar('Bar 1'); const water = await prod('Water', 'water');
    await stock(b1._id, water._id, 1);                // no threshold
    const { perBar } = await StockReportService.board(String(eventId));
    expect(perBar[0].status).toBe('IN_STOCK');
    expect(perBar[0].lowStockThreshold).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/services/__tests__/stockReport.board.test.ts`
Expected: FAIL — `Cannot find module '@services/stockReport.service'`.

- [ ] **Step 4: Create the service with `board`**

```typescript
// src/services/stockReport.service.ts
import mongoose from 'mongoose';
import { ProductStock } from '@models/productStock.model';
import { Product } from '@models/product.model';
import { Merchant } from '@models/merchant.model';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Eswatini is UTC+2; all Carrot events are Eswatini today. Named so peak-time
 *  bucketing (§dashboard) is a one-line change when Carrot goes multi-region. */
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
    const [rows, products, merchants] = await Promise.all([
      ProductStock.find({ eventId: eid }).lean(),
      Product.find({ eventId: eid }).select('name category').lean(),
      Merchant.find({ eventId: eid }).select('name').lean(),
    ]);
    const productName = new Map(products.map((p: any) => [String(p._id), p.name]));
    const productCat = new Map(products.map((p: any) => [String(p._id), p.category]));
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));

    const perBar = rows.map((r: any) => {
      const threshold = r.lowStockThreshold ?? null;
      return {
        merchantId: String(r.merchantId),
        merchantName: merchantName.get(String(r.merchantId)) || 'Unknown bar',
        productId: String(r.productId),
        productName: productName.get(String(r.productId)) || 'Unknown product',
        category: productCat.get(String(r.productId)) || 'other',
        onHand: r.onHand,
        lowStockThreshold: threshold,
        status: statusOf(r.onHand, threshold),
      };
    }).sort((a, b) => a.productName.localeCompare(b.productName) || a.merchantName.localeCompare(b.merchantName));

    // Aggregate one product across all its bars.
    const agg = new Map<string, { totalOnHand: number; anyLow: boolean }>();
    for (const r of perBar) {
      const a = agg.get(r.productId) || { totalOnHand: 0, anyLow: false };
      a.totalOnHand += r.onHand;
      if (r.status === 'LOW') a.anyLow = true;
      agg.set(r.productId, a);
    }
    const byProduct = [...agg.entries()].map(([productId, a]) => ({
      productId,
      productName: productName.get(productId) || 'Unknown product',
      category: productCat.get(productId) || 'other',
      totalOnHand: a.totalOnHand,
      status: a.totalOnHand <= 0 ? 'SOLD_OUT' : (a.anyLow ? 'LOW' : 'IN_STOCK') as StockStatus,
    })).sort((a, b) => a.productName.localeCompare(b.productName));

    return { perBar, byProduct };
  }
}
```

- [ ] **Step 5: Run the service test to verify it passes**

Run: `npx jest src/services/__tests__/stockReport.board.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Create the controller with `board`**

```typescript
// src/controllers/stockReport.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { StockReportService } from '@services/stockReport.service';

/**
 * Organiser stock reporting (design 2026-08-13, Slice 4). Read-only surfaces —
 * live board, reconciliation, event dashboard, movements journal. Every method
 * asserts event ownership + cashless via the shared guard, then delegates to
 * the aggregation service. VIEW_REVENUE-gated at the route.
 */
export class StockReportController {
  /** GET /api/tickets/events/:eventId/stock/board */
  static async board(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.board(eventId);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock board', 500);
    }
  }
}
```

- [ ] **Step 7: Mount the route**

In `src/routes/tickets.route.ts`, add the import near the other controller imports:
```typescript
import { StockReportController } from '@controllers/stockReport.controller';
```
Then, immediately after the `/cashless/transactions` route (line ~516), add:
```typescript
/**
 * Cashless Stock Reporting (design 2026-08-13, Slice 4) — organiser read-only
 * views over the stock journal: live board, reconciliation, event dashboard,
 * movements audit. Stock figures are revenue-adjacent → VIEW_REVENUE; ownership
 * (own cashless event only) enforced by the shared guard in the controller.
 */
router.get('/events/:eventId/stock/board', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.board);
```

- [ ] **Step 8: Write the failing board route test**

```typescript
// src/routes/__tests__/stockReportBoard.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function ownedCashlessEvent(perms = [TicketsPermission.VIEW_REVENUE]) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: perms });
  return { eventId: String(eventId), vendorId: String(vendorId), token };
}

describe('GET /api/tickets/events/:id/stock/board', () => {
  it('returns per-bar + aggregated board for the owner', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const bar = await Merchant.create({ name: 'Main Bar', eventId, status: 'active', pin: '0000' } as any);
    const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
    await ProductStock.create({ eventId, merchantId: bar._id, productId: p._id, onHand: 0, lowStockThreshold: 5 } as any);

    const res = await request(app).get(`/api/tickets/events/${eventId}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.perBar[0].status).toBe('SOLD_OUT');
    expect(res.body.data.byProduct[0].totalOnHand).toBe(0);
  });

  it('rejects a caller without VIEW_REVENUE', async () => {
    const { eventId } = await ownedCashlessEvent();
    const token = signVendorToken('anyone', { permissions: [] });
    const res = await request(app).get(`/api/tickets/events/${eventId}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("forbids another vendor's event", async () => {
    const { eventId } = await ownedCashlessEvent();
    const token = signVendorToken('someone-else', { permissions: [TicketsPermission.VIEW_REVENUE] });
    const res = await request(app).get(`/api/tickets/events/${eventId}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('400s a non-cashless event', async () => {
    const { eventId: eid, vendorId } = await seedPublishedEvent({});   // cashless stays false
    const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
    const res = await request(app).get(`/api/tickets/events/${eid}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 9: Run the route test to verify it passes**

Run: `npx jest src/routes/__tests__/stockReportBoard.route.test.ts`
Expected: PASS. (Verify the 403/400 branches come from the shared guard, not a crash.)

- [ ] **Step 10: Commit**

```bash
git add src/services/stockReport.service.ts src/controllers/stockReport.controller.ts \
        src/controllers/organizerCashless.controller.ts src/routes/tickets.route.ts \
        src/services/__tests__/stockReport.board.test.ts src/routes/__tests__/stockReportBoard.route.test.ts
git commit -m "feat(cashless-stock): live stock board endpoint (Slice 4)"
```

---

### Task 2: `StockReportService.reconciliation` (Opening → … → Variance)

**Files:**
- Modify: `src/services/stockReport.service.ts` (add `reconciliation`)
- Modify: `src/controllers/stockReport.controller.ts` (add `reconciliation`)
- Modify: `src/routes/tickets.route.ts` (mount `/stock/reconciliation`)
- Test: `src/services/__tests__/stockReport.reconciliation.test.ts`, `src/routes/__tests__/stockReportReconciliation.route.test.ts`

**Interfaces:**
- Consumes: `StockMovement`, `StockCount`, `ProductStock`, `Product`, `Merchant`; `event.startTime` from the guard.
- Produces:
  - `StockReportService.reconciliation(eventId: string, startTime: Date): Promise<{ perBar: ReconRow[]; byProduct: ReconRollup[]; total: ReconTotals }>`
    where `ReconRow = { merchantId, merchantName, productId, productName, opening, added, transferIn, transferOut, sold, countAdjust, spoilage, manual, expectedClosing, physicalCount: number|null, variance: number|null }`, `ReconRollup` = the same numeric fields summed per product (no merchant fields; `physicalCount`/`variance` summed treating null as absent), `ReconTotals` = the numeric fields summed across all rows.
  - `StockReportController.reconciliation`; `GET /api/tickets/events/:eventId/stock/reconciliation`.

- [ ] **Step 1: Write the failing reconciliation service test**

```typescript
// src/services/__tests__/stockReport.reconciliation.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { StockService } from '@services/stock.service';
import { StockCountService } from '@services/stockCount.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';

const eventId = new mongoose.Types.ObjectId();
const startTime = new Date('2026-08-13T18:00:00Z');   // doors open

async function receive(merchantId: any, productId: any, delta: number, at: Date) {
  // applyMovement stamps `at = Date.now()`; write the movement then backdate for the split test.
  const { movement } = await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(merchantId), productId: String(productId),
    delta, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1',
  } as any);
  await mongoose.model('StockMovement').updateOne({ _id: movement._id }, { $set: { at } });
}

describe('StockReportService.reconciliation', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('splits opening vs added on startTime and derives expected == onHand', async () => {
    const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
    const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
    await receive(bar._id, p._id, 100, new Date('2026-08-13T15:00:00Z'));   // pre-doors -> opening
    await receive(bar._id, p._id, 40,  new Date('2026-08-13T20:00:00Z'));   // post-doors -> added
    // a sale of 30
    await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), delta: -30, reason: StockMovementReason.SALE, byType: 'Merchant', by: 'till', refId: 'c1' } as any);

    const { perBar, total } = await StockReportService.reconciliation(String(eventId), startTime);
    const row = perBar[0];
    expect(row.opening).toBe(100);
    expect(row.added).toBe(40);
    expect(row.sold).toBe(30);
    expect(row.expectedClosing).toBe(110);            // onHand = 100 + 40 - 30
    // identity holds
    expect(row.opening + row.added + row.transferIn - row.sold - row.transferOut + row.countAdjust - row.spoilage + row.manual)
      .toBe(row.expectedClosing);
    expect(total.sold).toBe(30);
  });

  it('takes physical + variance from the latest closing count', async () => {
    const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
    const p = await Product.create({ eventId, name: 'Savanna', category: 'wine', price: 3000 } as any);
    await receive(bar._id, p._id, 50, new Date('2026-08-13T15:00:00Z'));
    // physical count finds 45 (5 short) -> closing StockCount variance -5, count_adjust -5
    await StockCountService.recordCount({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), countedOnHand: 45, phase: 'closing', byType: 'Organizer', by: 'v1' } as any);

    const { perBar } = await StockReportService.reconciliation(String(eventId), startTime);
    const row = perBar[0];
    expect(row.physicalCount).toBe(45);
    expect(row.variance).toBe(-5);
    expect(row.countAdjust).toBe(-5);
    expect(row.expectedClosing).toBe(45);             // book reconciled to reality
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/services/__tests__/stockReport.reconciliation.test.ts`
Expected: FAIL — `StockReportService.reconciliation is not a function`.

- [ ] **Step 3: Implement `reconciliation`**

Add to `StockReportService` in `src/services/stockReport.service.ts` (import `StockMovement`, `StockCount`, `StockMovementReason` at the top):

```typescript
  /**
   * Opening → Added → Transfers → Sold → Expected → Physical → Variance, per
   * bar-product, rolled up per product + a grand total. `opening` = an explicit
   * opening-count if present else pre-doors receives; `added` = post-doors
   * receives; `expectedClosing` = the authoritative onHand; physical + variance
   * come from the latest CLOSING count. Derived from the journal by reason.
   */
  static async reconciliation(eventId: string, startTime: Date) {
    const eid = oid(eventId);
    const [byReason, receiveSplit, counts, stockRows, products, merchants] = await Promise.all([
      StockMovement.aggregate([
        { $match: { eventId: eid } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId', reason: '$reason' }, qty: { $sum: '$delta' } } },
      ]),
      StockMovement.aggregate([
        { $match: { eventId: eid, reason: StockMovementReason.RECEIVE } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId', pre: { $lt: ['$at', startTime] } }, qty: { $sum: '$delta' } } },
      ]),
      // latest opening + closing count per (merchant, product)
      StockCount.aggregate([
        { $match: { eventId: eid, phase: { $in: ['opening', 'closing'] } } },
        { $sort: { at: -1 } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId', phase: '$phase' }, countedOnHand: { $first: '$countedOnHand' }, variance: { $first: '$variance' } } },
      ]),
      ProductStock.find({ eventId: eid }).lean(),
      Product.find({ eventId: eid }).select('name').lean(),
      Merchant.find({ eventId: eid }).select('name').lean(),
    ]);

    const productName = new Map(products.map((p: any) => [String(p._id), p.name]));
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));
    const key = (m: any, p: any) => `${m}|${p}`;

    // Base a row per bar-product that HAS a stock row (the universe of bar-products).
    const rowByKey = new Map<string, any>();
    const ensure = (merchantId: string, productId: string) => {
      const k = key(merchantId, productId);
      let r = rowByKey.get(k);
      if (!r) {
        r = { merchantId, merchantName: merchantName.get(merchantId) || 'Unknown bar', productId, productName: productName.get(productId) || 'Unknown product',
              opening: 0, added: 0, transferIn: 0, transferOut: 0, sold: 0, countAdjust: 0, spoilage: 0, manual: 0, expectedClosing: 0, physicalCount: null, variance: null };
        rowByKey.set(k, r);
      }
      return r;
    };
    for (const s of stockRows) { const r = ensure(String(s.merchantId), String(s.productId)); r.expectedClosing = s.onHand; }

    // Fold movement sums by reason (signs: transfer_out/sale/spoilage deltas are negative -> report as positive magnitudes).
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
    // Opening (pre-doors receive) vs Added (post-doors receive).
    for (const g of receiveSplit) {
      const r = ensure(String(g._id.merchantId), String(g._id.productId));
      if (g._id.pre) r.opening += g.qty; else r.added += g.qty;
    }
    // An explicit opening count overrides the pre-doors-receive baseline.
    for (const c of counts) {
      const r = ensure(String(c._id.merchantId), String(c._id.productId));
      if (c._id.phase === 'opening') r.opening = c.countedOnHand;
      else { r.physicalCount = c.countedOnHand; r.variance = c.variance; }   // closing
    }

    const perBar = [...rowByKey.values()].sort((a, b) => a.productName.localeCompare(b.productName) || a.merchantName.localeCompare(b.merchantName));

    // Roll up per product + a grand total.
    const NUM = ['opening', 'added', 'transferIn', 'transferOut', 'sold', 'countAdjust', 'spoilage', 'manual', 'expectedClosing'] as const;
    const blank = () => Object.fromEntries(NUM.map(k => [k, 0])) as Record<typeof NUM[number], number>;
    const byProdMap = new Map<string, any>();
    const total: any = { ...blank(), physicalCount: 0, variance: 0 };
    for (const r of perBar) {
      const agg = byProdMap.get(r.productId) || { productId: r.productId, productName: r.productName, ...blank(), physicalCount: 0, variance: 0 };
      for (const k of NUM) { agg[k] += r[k]; total[k] += r[k]; }
      if (r.physicalCount != null) { agg.physicalCount += r.physicalCount; total.physicalCount += r.physicalCount; }
      if (r.variance != null) { agg.variance += r.variance; total.variance += r.variance; }
      byProdMap.set(r.productId, agg);
    }
    const byProduct = [...byProdMap.values()].sort((a, b) => a.productName.localeCompare(b.productName));
    return { perBar, byProduct, total };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/services/__tests__/stockReport.reconciliation.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the controller method + route**

In `src/controllers/stockReport.controller.ts` add:
```typescript
  /** GET /api/tickets/events/:eventId/stock/reconciliation */
  static async reconciliation(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.reconciliation(eventId, event.startTime);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load reconciliation', 500);
    }
  }
```
In `src/routes/tickets.route.ts`, after `/stock/board`:
```typescript
router.get('/events/:eventId/stock/reconciliation', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.reconciliation);
```

- [ ] **Step 6: Write the failing route test**

```typescript
// src/routes/__tests__/stockReportReconciliation.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('returns a reconciliation row for the owner', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), delta: 80, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);

  const res = await request(app).get(`/api/tickets/events/${eventId}/stock/reconciliation`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.total.expectedClosing).toBe(80);
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest src/routes/__tests__/stockReportReconciliation.route.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/stockReport.service.ts src/controllers/stockReport.controller.ts src/routes/tickets.route.ts \
        src/services/__tests__/stockReport.reconciliation.test.ts src/routes/__tests__/stockReportReconciliation.route.test.ts
git commit -m "feat(cashless-stock): reconciliation endpoint — opening/added/sold/expected/variance (Slice 4)"
```

---

### Task 3: `StockReportService.dashboard` (Event Stock Dashboard + itemised split)

**Files:**
- Modify: `src/services/stockReport.service.ts` (add `dashboard`)
- Modify: `src/controllers/stockReport.controller.ts` (add `dashboard`)
- Modify: `src/routes/tickets.route.ts` (mount `/stock/dashboard`)
- Test: `src/services/__tests__/stockReport.dashboard.test.ts`, `src/routes/__tests__/stockReportDashboard.route.test.ts`

**Interfaces:**
- Consumes: `MerchantCharge` (amount, fee, netAmount, items[], staffName, merchantId, createdAt), `StockMovement` (sale), `ProductStock`, `StockCount` (closing variance), `Product`, `Merchant`.
- Produces: `StockReportService.dashboard(eventId: string): Promise<{ revenueByProduct: {productId,productName,revenue,units}[]; bestSellers: same[]; salesByBar: {merchantId,merchantName,gross,fee,net,count}[]; salesByEmployee: {staffName:string|null,label,gross,count}[]; itemisedSplit: { itemised:{gross,count}, unitemised:{gross,count} }; peakTimes: {hour:number,units:number}[]; variances: {merchantId,merchantName,productId,productName,variance}[]; totalShrinkageUnits: number; predictedStockOut: {merchantId,merchantName,productId,productName,onHand,ratePerMin,minutesToStockOut}[]; noRecentSales: number }>`.
- `StockReportController.dashboard`; `GET /api/tickets/events/:eventId/stock/dashboard`.

- [ ] **Step 1: Write the failing dashboard service test — THE ITEMISED LANDMINE**

```typescript
// src/services/__tests__/stockReport.dashboard.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';

const eventId = new mongoose.Types.ObjectId();

async function itemisedCharge(merchantId: any, productId: any, name: string, unitPrice: number, qty: number, staffName?: string, clientTxnId = String(new mongoose.Types.ObjectId())) {
  const lineTotal = unitPrice * qty;
  return MerchantCharge.create({ merchantId, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b1',
    amount: lineTotal, fee: 0, netAmount: lineTotal, clientTxnId, status: 'completed',
    items: [{ productId, name, unitPrice, qty, lineTotal }], ...(staffName ? { staffName } : {}) } as any);
}
async function amountOnlyCharge(merchantId: any, amount: number, clientTxnId = String(new mongoose.Types.ObjectId())) {
  // NO items field at all — mirrors MerchantService.charge amount-only path (default:undefined).
  return MerchantCharge.create({ merchantId, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b2',
    amount, fee: 0, netAmount: amount, clientTxnId, status: 'completed' } as any);
}

describe('StockReportService.dashboard', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('splits itemised vs un-itemised by items.0 existence (not the items field)', async () => {
    const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
    const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
    await itemisedCharge(bar._id, p._id, 'Castle Lite', 2500, 2);   // 5000 itemised
    await amountOnlyCharge(bar._id, 1500);                          // 1500 un-itemised

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.itemisedSplit.itemised.gross).toBe(5000);
    expect(d.itemisedSplit.itemised.count).toBe(1);
    expect(d.itemisedSplit.unitemised.gross).toBe(1500);           // the amount-only charge
    expect(d.itemisedSplit.unitemised.count).toBe(1);
    expect(d.itemisedSplit.itemised.gross + d.itemisedSplit.unitemised.gross).toBe(6500);
    expect(d.revenueByProduct[0]).toMatchObject({ productName: 'Castle Lite', revenue: 5000, units: 2 });
  });

  it('groups sales by bar and by employee (null -> Unattributed)', async () => {
    const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
    const p = await Product.create({ eventId, name: 'Savanna', category: 'wine', price: 3000 } as any);
    await itemisedCharge(bar._id, p._id, 'Savanna', 3000, 1, 'Thandi');
    await amountOnlyCharge(bar._id, 2000);                          // no staffName -> Unattributed

    const d = await StockReportService.dashboard(String(eventId));
    expect(d.salesByBar[0]).toMatchObject({ merchantName: 'Bar 1', gross: 5000, count: 2 });
    const unattributed = d.salesByEmployee.find(e => e.staffName === null)!;
    expect(unattributed.label).toBe('Unattributed');
    expect(unattributed.gross).toBe(2000);
    const thandi = d.salesByEmployee.find(e => e.staffName === 'Thandi')!;
    expect(thandi.gross).toBe(3000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/services/__tests__/stockReport.dashboard.test.ts`
Expected: FAIL — `StockReportService.dashboard is not a function`.

- [ ] **Step 3: Implement `dashboard`**

Add to `StockReportService` (uses `MerchantCharge`, `StockMovement`, `StockCount`, `ProductStock`, `Product`, `Merchant`, `EVENT_TZ_OFFSET`, `PREDICT_WINDOW_MIN`):

```typescript
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
        { $match: { eventId: eid, reason: 'sale' } },
        { $group: { _id: { $hour: { date: '$at', timezone: EVENT_TZ_OFFSET } }, units: { $sum: { $abs: '$delta' } } } },
      ]),
      StockCount.aggregate([
        { $match: { eventId: eid, phase: 'closing' } }, { $sort: { at: -1 } },
        { $group: { _id: { merchantId: '$merchantId', productId: '$productId' }, variance: { $first: '$variance' } } },
      ]),
      ProductStock.find({ eventId: eid }).lean(),
      StockMovement.aggregate([
        { $match: { eventId: eid, reason: 'sale', at: { $gte: windowStart } } },
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

    const itSplit = { itemised: { gross: 0, count: 0 }, unitemised: { gross: 0, count: 0 } };
    for (const s of split) { (s._id ? itSplit.itemised : itSplit.unitemised).gross += s.gross, (s._id ? itSplit.itemised : itSplit.unitemised).count += s.count; }

    const peakByHour = new Map<number, number>(peak.map((p: any) => [p._id, p.units]));
    const peakTimes = Array.from({ length: 24 }, (_, hour) => ({ hour, units: peakByHour.get(hour) || 0 }));

    const variances = closingCounts
      .filter((c: any) => c.variance !== 0)
      .map((c: any) => ({ merchantId: String(c._id.merchantId), merchantName: merchantName.get(String(c._id.merchantId)) || 'Unknown bar', productId: String(c._id.productId), productName: productName.get(String(c._id.productId)) || 'Unknown product', variance: c.variance }))
      .sort((a: any, b: any) => a.variance - b.variance);
    const totalShrinkageUnits = variances.reduce((s: number, v: any) => s + Math.min(v.variance, 0), 0);

    const soldByKey = new Map(saleWindow.map((s: any) => [`${s._id.merchantId}|${s._id.productId}`, s.units]));
    let noRecentSales = 0;
    const predictedStockOut = stockRows
      .filter((s: any) => s.onHand > 0)
      .map((s: any) => {
        const units = soldByKey.get(`${s.merchantId}|${s.productId}`) || 0;
        const ratePerMin = units / PREDICT_WINDOW_MIN;
        const minutesToStockOut = ratePerMin > 0 ? s.onHand / ratePerMin : null;
        if (minutesToStockOut == null) noRecentSales++;
        return { merchantId: String(s.merchantId), merchantName: merchantName.get(String(s.merchantId)) || 'Unknown bar', productId: String(s.productId), productName: productName.get(String(s.productId)) || 'Unknown product', onHand: s.onHand, ratePerMin, minutesToStockOut };
      })
      .filter((r: any) => r.minutesToStockOut != null)
      .sort((a: any, b: any) => (a.minutesToStockOut as number) - (b.minutesToStockOut as number));

    return { revenueByProduct, bestSellers, salesByBar, salesByEmployee, itemisedSplit: itSplit, peakTimes, variances, totalShrinkageUnits, predictedStockOut, noRecentSales };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/services/__tests__/stockReport.dashboard.test.ts`
Expected: PASS (both cases, especially the itemised split).

- [ ] **Step 5: Add controller method + route**

Controller:
```typescript
  /** GET /api/tickets/events/:eventId/stock/dashboard */
  static async dashboard(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.dashboard(eventId);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...data });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock dashboard', 500);
    }
  }
```
Route (after `/stock/reconciliation`):
```typescript
router.get('/events/:eventId/stock/dashboard', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.dashboard);
```

- [ ] **Step 6: Write the failing route test**

```typescript
// src/routes/__tests__/stockReportDashboard.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('returns the dashboard with the itemised split for the owner', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await MerchantCharge.create({ merchantId: bar._id, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b', amount: 5000, fee: 0, netAmount: 5000, clientTxnId: 't1', status: 'completed', items: [{ productId: p._id, name: 'Castle Lite', unitPrice: 2500, qty: 2, lineTotal: 5000 }] } as any);
  await MerchantCharge.create({ merchantId: bar._id, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b', amount: 1500, fee: 0, netAmount: 1500, clientTxnId: 't2', status: 'completed' } as any);

  const res = await request(app).get(`/api/tickets/events/${eventId}/stock/dashboard`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.itemisedSplit.itemised.gross).toBe(5000);
  expect(res.body.data.itemisedSplit.unitemised.gross).toBe(1500);
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest src/routes/__tests__/stockReportDashboard.route.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/stockReport.service.ts src/controllers/stockReport.controller.ts src/routes/tickets.route.ts \
        src/services/__tests__/stockReport.dashboard.test.ts src/routes/__tests__/stockReportDashboard.route.test.ts
git commit -m "feat(cashless-stock): event stock dashboard + itemised/un-itemised split (Slice 4)"
```

---

### Task 4: `StockReportService.movements` (audit journal, cursor-paginated)

**Files:**
- Modify: `src/services/stockReport.service.ts` (add `movements`)
- Modify: `src/controllers/stockReport.controller.ts` (add `movements`)
- Modify: `src/routes/tickets.route.ts` (mount `/stock/movements`)
- Test: `src/services/__tests__/stockReport.movements.test.ts`, `src/routes/__tests__/stockReportMovements.route.test.ts`

**Interfaces:**
- Consumes: `StockMovement`, `Product`, `Merchant`.
- Produces: `StockReportService.movements({ eventId, productId?, merchantId?, cursor?, limit? }): Promise<{ movements: MovementRow[]; nextCursor: string|null; hasMore: boolean }>` where `MovementRow = { id, at, merchantId, merchantName, productId, productName, delta, reason, balanceAfter, refType, refId, byType, by, note }`.
- `StockReportController.movements`; `GET /api/tickets/events/:eventId/stock/movements?productId=&merchantId=&cursor=&limit=`.

- [ ] **Step 1: Write the failing movements service test**

```typescript
// src/services/__tests__/stockReport.movements.test.ts
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { StockReportService } from '@services/stockReport.service';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';

const eventId = new mongoose.Types.ObjectId();

describe('StockReportService.movements', () => {
  beforeAll(connectLedgerTestDb, 60000);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('pages newest-first via _id cursor and filters by product', async () => {
    const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
    const a = await Product.create({ eventId, name: 'A', category: 'beer', price: 100 } as any);
    const b = await Product.create({ eventId, name: 'B', category: 'beer', price: 100 } as any);
    for (let i = 0; i < 3; i++) await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(a._id), delta: 10, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);
    await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(b._id), delta: 5, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);

    const page1 = await StockReportService.movements({ eventId: String(eventId), limit: 2 });
    expect(page1.movements).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.movements[0].productName).toBeDefined();

    const page2 = await StockReportService.movements({ eventId: String(eventId), limit: 2, cursor: page1.nextCursor! });
    // no overlap between pages
    const ids1 = page1.movements.map(m => m.id); const ids2 = page2.movements.map(m => m.id);
    expect(ids1.filter(id => ids2.includes(id))).toHaveLength(0);

    const onlyB = await StockReportService.movements({ eventId: String(eventId), productId: String(b._id) });
    expect(onlyB.movements).toHaveLength(1);
    expect(onlyB.movements[0].productName).toBe('B');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/services/__tests__/stockReport.movements.test.ts`
Expected: FAIL — `StockReportService.movements is not a function`.

- [ ] **Step 3: Implement `movements`**

Add to `StockReportService`:
```typescript
  /** The append-only stock journal for the event, newest first, cursor-paged on
   *  _id (movements are insert-ordered by the sole writer). Optional product/bar
   *  filters. Product + bar names joined per page. */
  static async movements(params: { eventId: string; productId?: string; merchantId?: string; cursor?: string; limit?: number }) {
    const { eventId, productId, merchantId, cursor } = params;
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const q: any = { eventId: oid(eventId) };
    if (productId) q.productId = oid(productId);
    if (merchantId) q.merchantId = oid(merchantId);
    if (cursor && /^[0-9a-fA-F]{24}$/.test(cursor)) q._id = { $lt: oid(cursor) };

    const docs = await StockMovement.find(q).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const productIds = [...new Set(page.map((d: any) => String(d.productId)))];
    const merchantIds = [...new Set(page.map((d: any) => String(d.merchantId)))];
    const [products, merchants] = await Promise.all([
      Product.find({ _id: { $in: productIds.map(oid) } }).select('name').lean(),
      Merchant.find({ _id: { $in: merchantIds.map(oid) } }).select('name').lean(),
    ]);
    const productName = new Map(products.map((p: any) => [String(p._id), p.name]));
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name]));

    const movements = page.map((d: any) => ({
      id: String(d._id), at: d.at, merchantId: String(d.merchantId), merchantName: merchantName.get(String(d.merchantId)) || 'Unknown bar',
      productId: String(d.productId), productName: productName.get(String(d.productId)) || 'Unknown product',
      delta: d.delta, reason: d.reason, balanceAfter: d.balanceAfter, refType: d.refType ?? null, refId: d.refId ?? null, byType: d.byType, by: d.by, note: d.note ?? null,
    }));
    return { movements, nextCursor: hasMore ? String(page[page.length - 1]._id) : null, hasMore };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/services/__tests__/stockReport.movements.test.ts`
Expected: PASS.

- [ ] **Step 5: Add controller method + route**

Controller:
```typescript
  /** GET /api/tickets/events/:eventId/stock/movements?productId=&merchantId=&cursor=&limit= */
  static async movements(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const data = await StockReportService.movements({
        eventId,
        productId: req.query.productId ? String(req.query.productId) : undefined,
        merchantId: req.query.merchantId ? String(req.query.merchantId) : undefined,
        cursor: req.query.cursor ? String(req.query.cursor) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return ApiResponseUtil.success(res, data);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load stock movements', 500);
    }
  }
```
Route (after `/stock/dashboard`):
```typescript
router.get('/events/:eventId/stock/movements', requireTicketsPermission(TicketsPermission.VIEW_REVENUE), StockReportController.movements);
```

- [ ] **Step 6: Write the failing route test**

```typescript
// src/routes/__tests__/stockReportMovements.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('lists the journal newest-first for the owner', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  const bar = await Merchant.create({ name: 'Bar 1', eventId, status: 'active', pin: '0000' } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), delta: 20, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);

  const res = await request(app).get(`/api/tickets/events/${eventId}/stock/movements`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.movements[0]).toMatchObject({ reason: 'receive', delta: 20, productName: 'Castle Lite' });
});
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx jest src/routes/__tests__/stockReportMovements.route.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full stockReport test group + typecheck**

Run: `npx jest stockReport --maxWorkers=4` and `npx tsc --noEmit`
Expected: all green, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/services/stockReport.service.ts src/controllers/stockReport.controller.ts src/routes/tickets.route.ts \
        src/services/__tests__/stockReport.movements.test.ts src/routes/__tests__/stockReportMovements.route.test.ts
git commit -m "feat(cashless-stock): stock movements audit journal endpoint (Slice 4)"
```

---

## Self-Review checklist (run before requesting review)

- **Spec coverage:** board (§4.1/Task 1), reconciliation (§4.2/Task 2), dashboard incl. revenue-by-product, best-sellers, sales-by-bar, sales-by-employee, itemised split, peak times, variances, predicted stock-out (§4.3/Task 3), movements journal (§4.4/Task 4), VIEW_REVENUE + ownership on all four (every route test). ✅
- **Itemised landmine (decision C):** Task 3 Step 1 explicitly asserts an amount-only charge (no `items` field) classifies un-itemised and `itemised + unitemised === Σ amount`. ✅
- **No writes / no new models:** every method is `find`/`aggregate` only. ✅
- **Type consistency:** `board`/`reconciliation`/`dashboard`/`movements` signatures match between service, controller, and route across tasks; `loadOwnedCashlessEvent` exported in Task 1 and imported by every controller method. ✅
- **Full suite:** after Task 4, run `npx jest --maxWorkers=4` (the whole suite) and confirm green before the FF-merge.
