# Cashless Stock — Slice 4: Reporting & Reconciliation (Design)

**Date:** 2026-08-13
**Status:** Design — awaiting review
**Branch (base):** `feat/cashless-stock-reporting` off `feat/cashless-cashier` (Slices 1+2+3 merged), worktree `api-stock-reporting-wt`. Merge onto the cashless line, not `main`.
**Repos:** `api` only (backend read-model). Dashboard/POS UI that consumes these endpoints is Slices 5/6.
**Builds on:** parent design `2026-08-12-cashless-stock-management-design.md` (§7 Reporting) + Slice 1 (`Product`/`ProductStock`/`StockMovement`, `StockService`), Slice 2 (`MerchantCharge.items`/`staffName`), Slice 3 (`StockCount`, `StockTransfer`, thresholds).

---

## 1. Why / scope

Slices 1-3 *record* everything: a sole-writer append-only `StockMovement` journal, a denormalised `ProductStock.onHand`, itemised `MerchantCharge.items`, and physical `StockCount`s. Slice 4 turns that durable record into the organiser's four read surfaces from the PDF — with **no new bookkeeping and no writes**. Every figure is a read-time aggregation over data that already exists, so reporting can never corrupt stock or money.

**In scope (api only):** four read-only endpoints under the existing `/api/tickets/...` organiser namespace, a dedicated `StockReportService`, a `StockReportController` (reusing the existing cashless event-ownership guard), and tests.

1. **Live stock board** — per-bar and aggregated `onHand` + `in_stock`/`LOW`/`SOLD_OUT` status.
2. **Reconciliation** — Opening → Added → Transfers(in/out) → Sold → Expected Closing (= `onHand`) → Physical → Variance, per bar-product and rolled up per product + grand total.
3. **Event Stock Dashboard** — revenue by product, best-sellers, sales by bar, sales by employee (`staffName`), peak selling times, stock variances, predicted stock-out, **itemised-vs-un-itemised revenue split**.
4. **Movements journal** — the raw `StockMovement` audit trail, filterable by product/bar, cursor-paginated.

**Out of scope:** any write (this slice only reads); the dashboard/POS UI that renders these (Slices 5/6); a shrinkage write-off/approval workflow (parent §11 — organiser only *sees* variance here); SMS/email report delivery.

## 2. Locked decisions (parent) + Slice-4 decisions

Parent locks that bind this slice: reporting is organiser-only, ownership-guarded, on the shipped `/api/tickets/...` namespace (parent §7); un-itemised revenue is **shown, not hidden** (decision #5); everything derives from `StockMovement` + `ProductStock` + `MerchantCharge.items`.

Engineering decisions made in this slice (called out, as Slice 3 called out its deviations):

| # | Decision | Choice |
|---|----------|--------|
| A | Permission | **Reuse `VIEW_REVENUE`** for all four endpoints (parent §7 floated a new `VIEW_STOCK`, but it was never added and stock figures are revenue-adjacent; a always-granted new perm is YAGNI). Consistent with the shipped `/cashless/summary` + `/cashless/transactions` routes. |
| B | Code placement | **New `StockReportService` + `StockReportController`** (not folded into the money-focused `organizerCashless.service.ts`). Cohesive, DRY, and keeps the stock read-model isolated. The controller **reuses** the existing `loadOwnedCashlessEvent` guard (exported from `organizerCashless.controller.ts`) so ownership + cashless-gating logic is not duplicated. |
| C | Itemised classification | **Classify by `items.0` existence, NEVER by `items` field existence.** Slice 2 stores amount-only charges with `default:undefined` (no `items` field). All aggregations use `itemised = { $gt: [ { $size: { $ifNull: ['$items', []] } }, 0 ] }`. This is the single most important invariant in the slice. |
| D | Opening vs Added split | The **doors-open marker is `event.startTime`** (authoritative UTC instant). **Opening** = the latest `phase:'opening'` `StockCount.countedOnHand` if one exists for the bar-product, else Σ `receive` movements with `at < startTime`. **Added** = Σ `receive` with `at >= startTime` (mid-event restock). This never double-counts: opening-count and opening-receives are alternatives, never summed. |
| E | Expected Closing | Read the authoritative `ProductStock.onHand` directly (not re-summed from movements). By the Slice-1 invariant `onHand == Σ deltas`, so it equals `opening + added + transferIn − sold − transferOut + countAdjust + spoilage + manual`; showing `onHand` avoids drift and is O(1). |
| F | Variance source | **Physical variance = the latest `closing`-phase `StockCount`** for the bar-product (`countedOnHand`, `variance`). This is the shrinkage/breakage/theft signal the client wants — distinct from `count_adjust` movements (which merely reconcile the book). `null` when no closing count was taken. |
| G | Peak selling times | Bucket `reason:'sale'` movements by **hour-of-day in Eswatini time (UTC+2)** via `$hour` with `timezone: '+02:00'` (all Carrot events are Eswatini; offset is a named constant `EVENT_TZ_OFFSET`, not scattered). Value per bucket = **units sold** (Σ `−delta`) + charge revenue in that hour. |
| H | Predicted stock-out | Computed **at read time, never stored** (parent §7). For each in-stock bar-product, `rate = unitsSoldInWindow / windowMinutes` over the last **`PREDICT_WINDOW_MIN = 60` min** (relative to now); `minutesToStockOut = onHand / rate`, only where `rate > 0`. Products with no recent sales have `null` (not "never"), surfaced as "no recent sales". |
| I | Movements pagination | Cursor on `_id` descending (ObjectIds are insertion-time-ordered; movements are inserted in time order). `?cursor=<lastId>&limit=` → `{ _id: { $lt: cursor } }`, `sort { _id: -1 }`, `limit+1` to compute `nextCursor`. Optional `productId` / `merchantId` filters. Product + bar names joined per page (batched). |

All money/stock records are **read-only** here; the money ledger and stock journal are untouched.

## 3. No new models, no new fields

Slice 4 adds **zero** models and **zero** schema fields. It reads:
- `ProductStock` (onHand, lowStockThreshold) — board + expected-closing + predicted stock-out base.
- `StockMovement` (delta, reason, at, balanceAfter) — reconciliation buckets, sold, peak times, predicted-stock-out window, movements journal.
- `MerchantCharge` (amount, fee, netAmount, items[], staffName, merchantId, createdAt) — revenue by product/bar/employee, itemised split.
- `StockCount` (expectedOnHand, countedOnHand, variance, phase, at) — opening baseline + closing variance.
- `Product` (name, category, price, active), `Merchant` (name) — display joins.
- `Event` (startTime, vendorId, cashless) — ownership guard + doors-open marker.

Two supporting read indexes already exist and cover these queries: `StockMovement { eventId:1, reason:1, at:-1 }` (Slice 1, "reporting: sales over time / peak hours") and `StockCount { eventId:1, phase:1, at:-1 }` (Slice 3). No new indexes required.

## 4. Service — `src/services/stockReport.service.ts` (`StockReportService`)

All methods take `eventId: string` (the caller has already loaded + ownership-checked the event). Pure reads; no sessions/transactions.

### 4.1 `board(eventId)` — live stock board
- Load the event's `Merchant`s (name) and `Product`s (name, category, active).
- `ProductStock.find({ eventId })` → per bar-product rows: `{ merchantId, merchantName, productId, productName, category, onHand, lowStockThreshold, status }`.
- `status`: `onHand === 0` → `SOLD_OUT`; else `lowStockThreshold != null && lowStockThreshold > 0 && onHand <= lowStockThreshold` → `LOW`; else `IN_STOCK`.
- Aggregate per product across bars: `{ productId, productName, category, totalOnHand, status }` (aggregate status uses `totalOnHand` vs the max threshold seen, or simply `SOLD_OUT` when total 0 / `LOW` when any bar is LOW — see §6 test).
- Return `{ perBar: [...], byProduct: [...] }`, each product-sorted by name.

### 4.2 `reconciliation(eventId)` — Opening → … → Variance
- Aggregate `StockMovement.aggregate([{ $match:{ eventId } }, { $group:{ _id:{ merchantId, productId, reason }, qty:{ $sum:'$delta' } } }])`, plus a **receive split** on `startTime`: a second `$match reason:'receive'` grouped by `{ merchantId, productId, preDoors: { $lt:['$at', startTime] } }`.
- Latest `opening` and `closing` `StockCount` per `(merchantId, productId)` (sort `at:-1`, first per group).
- Per bar-product row:
  ```
  { merchantId, merchantName, productId, productName,
    opening,         // openingCount.countedOnHand ?? Σ receive(at < startTime)
    added,           // Σ receive(at >= startTime)
    transferIn,      // Σ transfer_in
    transferOut,     // Σ |transfer_out|
    sold,            // Σ |sale|
    countAdjust,     // Σ count_adjust (signed)
    spoilage,        // Σ |spoilage|
    manual,          // Σ manual (signed)
    expectedClosing, // ProductStock.onHand (authoritative)
    physicalCount,   // closingCount.countedOnHand ?? null
    variance }       // closingCount.variance ?? null   (counted − expected: negative = shrinkage)
  ```
- Rolled up **per product** (Σ across bars) and a **grand total** row.
- Identity note surfaced in the payload doc: `opening + added + transferIn − sold − transferOut + countAdjust − spoilage + manual === expectedClosing` (holds by the Slice-1 invariant when opening = pre-doors receives; when opening = an opening-count, `count_adjust` from that count absorbs the difference).

### 4.3 `dashboard(eventId)` — Event Stock Dashboard
One `Promise.all` of independent aggregations:
- **revenueByProduct / bestSellers:** `MerchantCharge.aggregate` → `$match eventId` → `$unwind items` (itemised rows only naturally survive `$unwind` of a missing/empty array) → `$group _id:'$items.productId' { revenue:{$sum:'$items.lineTotal'}, units:{$sum:'$items.qty'} }` → join Product name → sort by revenue desc. `bestSellers` = top N by units.
- **salesByBar:** `$group _id:'$merchantId' { gross:{$sum:'$amount'}, fee, net, count }` → join Merchant name (matches the money `summary().vendors`, reused shape).
- **salesByEmployee:** `$group _id:{ $ifNull:['$staffName', null] } { gross:{$sum:'$amount'}, count }` → `null` bucket labelled `Unattributed`.
- **itemisedSplit:** `$group` with `itemised:{ $gt:[ { $size:{ $ifNull:['$items', []] } }, 0 ] }` → `{ itemised:{ gross, count }, unitemised:{ gross, count } }`. **(decision C — the classification landmine.)**
- **peakTimes:** `StockMovement.aggregate` `$match { eventId, reason:'sale' }` → `$group _id:{ $hour:{ date:'$at', timezone:EVENT_TZ_OFFSET } } { units:{ $sum:{ $abs:'$delta' } } }` → 0-23 buckets (fill gaps with 0).
- **variances:** the closing-count variances from §4.2 with non-zero variance, sorted most-negative first; plus `totalShrinkageUnits` = Σ negative variance.
- **predictedStockOut:** for each `ProductStock` with `onHand > 0`, `unitsSoldInWindow` = Σ `|sale delta|` where `at >= now − PREDICT_WINDOW_MIN`; `rate = units / PREDICT_WINDOW_MIN`; `minutesToStockOut = rate > 0 ? onHand/rate : null`; return the soonest first (nulls excluded from the ranked list, reported separately as `noRecentSales`).
- Return `{ revenueByProduct, bestSellers, salesByBar, salesByEmployee, itemisedSplit, peakTimes, variances, totalShrinkageUnits, predictedStockOut }`.

### 4.4 `movements({ eventId, productId?, merchantId?, cursor?, limit? })` — audit journal
- Filter `{ eventId, [productId], [merchantId], [_id: { $lt: cursor }] }`, `sort { _id: -1 }`, `limit = clamp(limit ?? 50, 1, 200)`, fetch `limit+1`.
- Join Product name + Merchant name for the page (batched, ≤2 look-ups).
- Return `{ movements:[{ id, at, merchantId, merchantName, productId, productName, delta, reason, balanceAfter, refType, refId, byType, by, note }], nextCursor, hasMore }`.

## 5. Controller + routes

**`src/controllers/stockReport.controller.ts` (`StockReportController`)** — four methods (`board`, `reconciliation`, `dashboard`, `movements`), each: `loadOwnedCashlessEvent(req,res,eventId)` (imported/exported from `organizerCashless.controller.ts` — DRY, decision B), then delegate to the service, then `ApiResponseUtil.success`. Errors → 500 via the same try/catch shape as `OrganizerCashlessController`.

**Export the guard:** add `export` to `loadOwnedCashlessEvent` in `organizerCashless.controller.ts` (currently module-private) so both controllers share it. No behaviour change.

**Routes — `src/routes/tickets.route.ts`, appended to the cashless reporting block (all `VIEW_REVENUE`):**
```
GET /events/:eventId/stock/board          → StockReportController.board
GET /events/:eventId/stock/reconciliation → StockReportController.reconciliation
GET /events/:eventId/stock/dashboard      → StockReportController.dashboard
GET /events/:eventId/stock/movements      → StockReportController.movements   (?productId=&merchantId=&cursor=&limit=)
```
These sit alongside the existing `POST /events/:eventId/stock/{receive,transfer,count}` (MANAGE_STOCK) and `GET/POST /events/:eventId/products` — same param name `:eventId`, no route collision (distinct sub-paths + methods).

## 6. Testing (TDD; `connectLedgerTestDb`)

Seed a small cashless event: 2 bars, 3 products, a mix of receives (pre- and post-`startTime`), a transfer, itemised sales, at least one amount-only (un-itemised) charge, one `opening` and one `closing` count with a deliberate non-zero closing variance, and `staffName` on some charges.

- **board:** SOLD_OUT at 0, LOW at/below threshold, IN_STOCK above; per-bar and aggregated-by-product; a product with a threshold of `null` never reads LOW.
- **reconciliation:** `opening` uses the opening-count when present else pre-doors receives; `added` = post-doors receives; `sold`/`transferIn`/`transferOut`/`countAdjust` correct signs; `expectedClosing === onHand`; the identity `opening+added+transferIn−sold−transferOut+countAdjust−spoilage+manual === expectedClosing` holds on the seeded data; per-product rollup + grand total sum the bar rows; `physicalCount`/`variance` come from the closing count and are `null` when absent.
- **dashboard — the itemised landmine (decision C):** a seed with **both** an itemised sale and an amount-only charge → `itemisedSplit.itemised.gross` counts only the item rows, `unitemised.gross` counts only the amount-only rows, and `itemised.gross + unitemised.gross === Σ amount`. Explicitly assert the amount-only charge is classified **un-itemised** (guards the `default:undefined` regression).
- **dashboard — rest:** revenueByProduct = Σ lineTotal per product; bestSellers ordered by units; salesByBar = Σ amount per merchant (incl. un-itemised); salesByEmployee groups by `staffName` with a `null`→Unattributed bucket; peakTimes buckets units into the correct UTC+2 hour; variances lists the closing shrinkage; predictedStockOut returns a finite `minutesToStockOut` for a product with recent sales and `null` for one with none.
- **movements:** newest-first, cursor pages without overlap/gap, `productId`/`merchantId` filters scope correctly, names joined.
- **permissions/ownership:** all four require `VIEW_REVENUE`; a non-owner vendor → 403; a non-cashless event → 400; unknown event → 404 (reusing the shared guard's behaviour).
- Reuse the existing harness; run the full suite with `--maxWorkers=4`.

## 7. Delivery

- Fresh worktree `api-stock-reporting-wt` on `feat/cashless-stock-reporting` off `feat/cashless-cashier` (post Slice-3 merge). FF-merge onto the cashless line, not `main`. Not deployed until the whole cashless system ships.
- Deploy topology unchanged. **Fail loudly:** these are read endpoints; on aggregation error they 500 with the message (no fabricated/empty "success"), per the workspace no-silent-fallback rule.

## 8. Open questions / carry-forward

- **Peak-time timezone** hardcodes Eswatini UTC+2 (`EVENT_TZ_OFFSET`). When Carrot goes multi-region, derive the offset from the event/venue. Named constant now so it's a one-line change.
- **Predicted stock-out window** (`PREDICT_WINDOW_MIN = 60`) is a fixed lookback; a fancier EWMA is deferrable. Documented as a constant.
- **Movements `_id` cursor** assumes insertion-time ordering (safe: movements are only ever inserted, never back-dated by the sole writer). If a future path sets `at` in the past, switch to an `{at,_id}` composite cursor.
- Carry-forward from Slices 1-3 unchanged: receive/transfer not client-idempotent (no `clientTxnId`).
