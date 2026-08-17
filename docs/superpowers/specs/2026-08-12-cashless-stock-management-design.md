# Cashless — Stock / Inventory Management (Design)

**Date:** 2026-08-12
**Status:** Design — awaiting review
**Branches (base):** `feat/cashless-cashier` (api), `feat/cashless-pos-cashier` (pos-app), dashboard `main`. Feature work happens on `feat/cashless-stock` in a fresh worktree per repo, off those bases; merges onto the cashless line, **not** `main`, until the whole cashless system ships.
**Repos:** `api` (backend, worktree `api-cashier-wt`), `pos-app` (Flutter handheld, worktree `pos-app-cashier-wt`), `dashboard` (organizer web).
**Builds on:** `2026-08-07-cashless-tag-ticket-registration-design.md` + `2026-08-11-cashless-cashier-and-organizer-reporting-design.md` (the wallet / ledger / merchant-charge / cashier system).

---

## 1. Why

The client's vision (verbatim source: *Carrot Cashless Stock Management Feature*): turn the handheld into **both a payment terminal and a live inventory system**, so Carrot manages the whole event commerce operation:

> **Ticketing → Entry → Cashless Payments → Vendors → Stock Control → Reconciliation**
> Instead of the organiser needing a separate POS/inventory company, Carrot manages the entire event commerce operation.

Concretely, from the source:

- **Before the event:** organiser/vendor loads stock into Carrot (e.g. *Castle Lite 330ml — 500 units — E25*). Products created manually or **scanned once** so Carrot recognises the manufacturer barcode.
- **During a sale:** bartender scans the bottle/can barcode → Carrot identifies product + price → customer taps NFC band → payment deducted → **1 unit auto-deducted from stock** → the transaction appears immediately on the organiser dashboard, itemised (product, price, customer band, vendor, staff, **stock before / stock after**, payment result).
- **Live stock control:** "Castle Lite: 63 remaining", "Heineken: 12 — LOW STOCK", "Savanna: SOLD OUT" across every bar in real time; auto-alert when an item hits a threshold (e.g. 20 units).
- **Stock transfers:** move N units from Bar A to Bar B; system records who moved it, from/to which bar, when.
- **Opening vs sales vs closing reconciliation:** Opening + Added − Sold = Expected Closing; vs Physical Count = **Variance** (surfaces missing stock, breakages, theft, unrecorded sales).
- **Cases vs units:** a case = 24 bottles; warehouse receives 50 cases = 1,200 bottles; bars sell individual bottles — Carrot auto-converts.
- **Any category:** not just alcohol — soft drinks, water, food, merchandise, cigarettes (where legal), VIP bottles, ice, cups.
- **Event Stock Dashboard:** revenue by product, best-selling product, stock remaining, sales by bar, sales by employee, peak selling times, stock variances, predicted time-to-stock-out.

**The one structural gap this attaches to (confirmed by code map):** a spend today is **amount-only**. `MerchantService.charge` (`POST /api/merchant/charge`) atomically does a wallet-balance CAS debit + balanced ledger legs + a `MerchantCharge` row, idempotent on `{merchantId, clientTxnId}` — but records **nothing about what was sold**. No product / SKU / inventory model exists anywhere. This feature adds the "what was sold" and the stock ledger behind it, decrementing stock **inside the same charge transaction** so money and stock stay perfectly consistent.

## 2. Decisions (locked with the client)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Delivery scope | **Full vision, one build** (this spec covers all of §1). The implementation plan slices it into PRs, per convention. |
| 2 | POS sale input | **Scan + product tiles.** Barcode scan for barcoded goods; on-screen product buttons for non-barcoded (food, ice, cups, VIP bottles) and fast-movers. Both identify the product, charge its catalogue price, deduct stock. |
| 3 | Oversell behaviour | **Hard block at zero.** A sale line whose bar-stock is insufficient **declines** (like an insufficient wallet balance). Counts never go negative from a sale. Stock is loaded/transferred before selling. |
| 4 | Stock-operations actor | **Organiser + existing vendor operators — no new role.** Organiser manages catalogue + stock + transfers on the dashboard; a bar's merchant login does its own physical counts on the POS. |
| 5 | Amount-only sales | **Keep both, but flag.** Item sales are the default; a free-typed amount is still allowed for un-catalogued items, recorded with **no line items / no stock deduction** and visibly marked **"un-itemised"** in reporting so the organiser sees the untracked-revenue gap. |
| 6 | Catalogue grain | **Event-scoped** (`Product.eventId`), matching `Merchant`/`Wallet`. "Scan once so Carrot recognises the barcode" is satisfied within the event (first scan of an unknown barcode offers create-product). An org-wide reusable library is a clean future extension (§15). |
| 7 | Per-employee attribution | **Optional `staffName` captured per till session** (POS asks "who's on this till?" at shift start), stored on `MerchantCharge`. Delivers "sales by employee" with **no new auth surface**. |
| 8 | Opening stock | An explicit `phase:'opening'` count (or the initial load) is the baseline the end-of-event variance reconciles against. |

**Currency/units:** money in integer ZAR cents (unchanged); **stock in integer base units** (bottles/cans/items). Packs (cases) convert to base units at the entry/display boundary only.

## 3. Architecture approach

**Chosen — A: line-items on the charge + a stock ledger, decremented atomically inside `MerchantService.charge`.** The sale carries line items; each line performs a per-product stock CAS (`onHand ≥ qty`) in the **same Mongo transaction** as the wallet-balance CAS. Two guards, one atomic commit: insufficient balance *or* any out-of-stock line ⇒ the whole tap declines and nothing moves (the wallet debit rolls back). This is the only approach that cleanly delivers **hard-block-at-zero**, and it reuses the proven ledger + single-document-CAS patterns verbatim.

*Rejected — B: a separate POS "order" domain* parallel to the charge (`MerchantCharge` stays amount-only, an `Order` references it): introduces an order-total-vs-charge-amount sync problem for no benefit. *Rejected — C: async inventory* (charge emits a "sold" event, a stock service decrements later): cleanest boundaries but **cannot hard-block at zero** — stock isn't checked at tap time — so decision #3 rules it out.

**Guiding principle (mirror the money ledger).** Money is a denormalised `Wallet.balance` (the atomic CAS source) backed by an append-only `LedgerEntry` journal whose deltas sum to the balance, with `LedgerService.post` the sole writer and a sums-to-zero property test. Stock copies this exactly: a denormalised `ProductStock.onHand` per bar-product (the atomic CAS source that enforces hard-block) backed by an append-only `StockMovement` journal, with `StockService.post` the sole writer and an `onHand == Σ deltas` property test. The PDF's *Opening + Added − Sold = Expected vs Physical = Variance* is then **invariant-by-construction**, not a nightly reconciliation hope.

## 4. Data models (new — `api-cashier-wt/src/models/`)

Follows repo convention: self-registering `mongoose.model(...)`, integer units, indexes declared once, `toJSON` clean. No central registry — import where used.

**`Product`** — the catalogue item + its price. Event-scoped.
```
Product {
  eventId: ObjectId → Event (required, indexed)
  name: string (required)
  barcode?: string                 // manufacturer EAN/UPC; unique per event (sparse)
  category: 'beer'|'spirits'|'wine'|'soft_drink'|'water'|'food'|'merch'|'cigarettes'|'other'
  price: number                    // integer ZAR cents (per base unit)
  unitLabel: string (default 'unit')     // 'bottle','can','plate','cup'
  unitsPerPack?: number            // e.g. 24 — for case↔unit conversion
  packLabel?: string               // 'case','crate','box'
  imageUrl?: string
  active: boolean (default true, indexed)
}
index { eventId: 1, barcode: 1 } unique sparse     // one product per barcode per event
index { eventId: 1, active: 1 }
```

**`ProductStock`** — per-**bar** on-hand count; the fast CAS source that enforces hard-block.
```
ProductStock {
  eventId: ObjectId (required, indexed)
  merchantId: ObjectId → Merchant (required, indexed)   // the "bar"
  productId: ObjectId → Product (required, indexed)
  onHand: number (integer base units, ≥ 0, default 0)
  lowStockThreshold?: number       // per bar-product; alert fires when onHand crosses it downward
  lowStockAlertedAt?: Date         // debounce so we alert once per crossing, not per sale
}
index { merchantId: 1, productId: 1 } unique
index { eventId: 1, productId: 1 }                // aggregate a product across bars
```

**`StockMovement`** — append-only inventory **journal**; the who/what/when audit for every delta. Sole writer: `StockService.post`.
```
StockMovement {
  eventId: ObjectId (required, indexed)
  merchantId: ObjectId (required, indexed)
  productId: ObjectId (required, indexed)
  delta: number                    // signed base units (+receive/+transfer_in, −sale/−transfer_out)
  reason: 'receive'|'sale'|'transfer_in'|'transfer_out'|'count_adjust'|'spoilage'|'manual'
  balanceAfter: number             // onHand after this movement (for "stock before/after" on receipts)
  refType?: string                 // 'merchant_charge'|'stock_transfer'|'stock_count'|...
  refId?: string                   // clientTxnId / transferId / countId
  byType: 'Organizer'|'Merchant'|'Platform'
  by: string                       // actor id
  note?: string
  at: Date (default now, indexed)
}
index { merchantId: 1, productId: 1, at: -1 }
index { eventId: 1, reason: 1, at: -1 }           // reporting (sales over time, peak hours)
```

**`StockTransfer`** — a bar→bar move; writes a paired `transfer_out` + `transfer_in` movement atomically.
```
StockTransfer {
  eventId, productId,
  fromMerchantId → Merchant, toMerchantId → Merchant,
  qty: number (> 0, base units),
  byType, by, note?, at
}
```

**`StockCount`** — a physical stock-take; expected vs counted, variance preserved for reporting.
```
StockCount {
  eventId, merchantId, productId,
  expectedOnHand: number,          // onHand at count time
  countedOnHand: number,           // physically counted
  variance: number,                // counted − expected (negative = shrinkage)
  phase: 'opening'|'interim'|'closing',
  byType, by, at
}
// writes a StockMovement { reason:'count_adjust', delta: variance } so the book == reality
```

**Additive change to the existing sale record** (called out explicitly per the no-silent-back-compat rule):
```
MerchantCharge  += {
  items?: [{ productId, name, unitPrice (cents), qty, lineTotal (cents) }]   // absent ⇒ un-itemised
  staffName?: string
}
// `amount` stays the ledger-authoritative total (= Σ lineTotal for itemised sales).
// The money ledger, reconciliation, and all existing cashless reporting are UNCHANGED.
```
Existing `MerchantCharge` rows (amount-only) remain valid and simply read as **un-itemised** — which is exactly decision #5's "keep both, but flag". No backfill needed.

## 5. The stock ledger & invariants

- **Denormalised `onHand`** is the truth the sale CAS reads (single-document atomicity ⇒ no oversell).
- **Journal identity (free):** for every bar-product, `onHand == Σ(its StockMovement.delta)`. Guaranteed by making `StockService.post` the only writer; asserted as a cheap tripwire against direct DB writes (mirrors the ledger's per-`txnId` sum-to-zero check).
- **Reconciliation identity (the PDF's model), derivable from the journal by `reason`:**
  `Σreceive + Σtransfer_in − Σsale − Σtransfer_out + Σcount_adjust + Σspoilage == onHand` (starting from 0 in Carrot).
  The human-facing **Opening vs Added** split is a *presentation* of the `receive` movements partitioned by the event's doors-open marker — **Opening** = the `phase:'opening'` count if recorded, else Σ`receive` before doors-open; **Added** = Σ`receive` after — so the two never double-count.
  Then **Variance at a closing count = counted − expected**, recorded as a `count_adjust`. Missing stock (theft/breakage/unrecorded sale) shows as the residual the count has to adjust away.
- **`balanceAfter` on each movement** captures "stock before / stock after" so the itemised receipt (§1) and the transaction log show it without recomputation.

## 6. Flows

### 6.1 Sale — POS `Charge` tab becomes a basket POS
1. Add lines: **scan** a barcode (`GET /api/merchant/products?barcode=` resolves the product via the merchant JWT's `eventId`; unknown barcode → offer create-product if permitted, else keypad fallback) **or tap a product tile** (grid of the bar's products; fast-movers pinned). Lines accumulate as `[{productId, qty}]`; running total = `Σ price×qty`.
2. **Tap the band once** to settle the whole basket.
3. Server `MerchantService.charge` (extended), one `session.withTransaction`, idempotent on `{merchantId, clientTxnId}`:
   ```
   a. Resolve products (this event) → amount = Σ price×qty        // SERVER-priced; never trust client amounts
   b. Wallet CAS debit { _id, eventId, status:'active', balance ≥ amount }
        null ⇒ decline 402 insufficient_balance (balance untouched)
   c. For each line:
        ProductStock.findOneAndUpdate(
          { merchantId, productId, onHand ≥ qty },
          { $inc:{ onHand:-qty } }, { new, session })
        null ⇒ ABORT txn ⇒ decline 409 out_of_stock { productId, available }   // HARD BLOCK
        else StockService.post({ reason:'sale', delta:-qty, balanceAfter, refId:clientTxnId, session })
   d. LedgerService.post(... existing money legs, UNCHANGED ...)
   e. MerchantCharge.create({ ..., amount, items, staffName })
   f. Low-stock check: for each line whose onHand crossed ≤ threshold → enqueue alert (§6.5)
   ```
   Because it is one transaction, an out-of-stock line **rolls back the wallet debit** — the attendee is never charged for a tap that didn't fully land. **Amount-only path preserved:** a request with `amount` and no `items` skips (a)/(c) and behaves exactly as today (no stock touched), recorded un-itemised.
4. Receipt: the existing "New balance: RX" success screen now lists the items + `stock after` per line.

**Concurrency (tested):** two taps racing for the last unit both hit the single-document `onHand ≥ qty` CAS; exactly one wins, the other declines. Exactly `floor(onHand/qty)` of N concurrent identical taps succeed. Decline leaves balance **and** stock untouched.

### 6.2 Receive / load stock (organiser, dashboard)
Pick bar + product, enter quantity **in packs or units** (`50 cases` with `unitsPerPack:24` ⇒ `+1200` base units). Writes a `receive` movement (`$inc onHand`). Setting the initial quantity before doors open is the opening baseline (or record an explicit `phase:'opening'` count).

### 6.3 Transfer bar→bar (organiser, dashboard)
`StockTransfer` writes paired `transfer_out`(from) + `transfer_in`(to) in one transaction, with a **source-side `onHand ≥ qty` CAS** so a bar can't transfer stock it doesn't have. Full audit (who/from/to/when/qty). Aggregate product view ("Castle Lite across all bars") comes from `ProductStock` grouped by `productId`.

### 6.4 Physical count / stock-take
- **On the POS** (bar's merchant login): list this bar's products → enter counted quantities → `POST /api/merchant/stock/count`. Records `expected = onHand`, `counted`, `variance`, writes a `count_adjust` movement of `counted − expected`, stores the `StockCount`. `phase` opening/interim/closing.
- **On the dashboard** (organiser): count any bar.

### 6.5 Low-stock thresholds & alerts
When a sale drops `onHand ≤ lowStockThreshold` (crossing downward, debounced via `lowStockAlertedAt`), fire a notification to the organiser via the **existing notification system** — e.g. "Heineken @ Bar 4: 12 remaining — LOW STOCK". `onHand == 0` ⇒ tile shows **SOLD OUT**; taps hard-block (§6.1c). Per the no-silent-fallback rule, a failed alert send is logged, never swallowed as success.

### 6.6 Cases ↔ units
Stored in base units everywhere. `unitsPerPack` drives pack⇄unit conversion at entry (receive in cases) and display (show "50 cases + 3 loose") only. Sales and counts are always base units.

## 7. Reporting (api + dashboard)

All derived from `StockMovement` + `ProductStock` + `MerchantCharge.items` — no new bookkeeping. Extends `organizerCashless.service.ts` and the **Cashless** tab (`EventCashlessTab.tsx`) with a **Stock** sub-section, plus a new organiser **Catalogue / Stock** management page.

- **Live stock board** — per bar and aggregated: `onHand` + status `in_stock / LOW / SOLD_OUT` ("Castle Lite: 63", "Heineken: 12 — LOW STOCK", "Savanna: SOLD OUT").
- **Reconciliation** — per product/bar and rolled up: Opening → Added → (Transfers in/out) → Sold → **Expected Closing** (= `onHand`) → Physical (closing count) → **Variance**.
- **Event Stock Dashboard** — revenue by product (`Σ lineTotal`), best-sellers, stock remaining, **sales by bar** (per merchant), **sales by employee** (`staffName`), **peak selling times** (`sale` movements bucketed by time), stock variances (from counts), **predicted stock-out** (recent sales-rate → minutes-to-zero, computed at read time, not stored).
- **Un-itemised visibility** (decision #5): reports show itemised vs un-itemised revenue split so the organiser can see and chase untracked sales.

**Endpoints (organiser, ownership-guarded, `VIEW_REVENUE`/new `VIEW_STOCK`) — under the shipped `/api/tickets/...` namespace (matches the existing `/tickets/events/:id/cashless/*` reporting routes in `routes/tickets.route.ts`, not the older spec's `/api/organizer/...`):**
`GET /api/tickets/events/:id/stock/board`, `/stock/reconciliation`, `/stock/dashboard`, `/stock/movements?productId=&merchantId=&cursor=`.
**Management (organiser, new `MANAGE_STOCK`):** `POST/GET/PATCH /api/tickets/events/:id/products`, `POST .../stock/receive`, `POST .../stock/transfer`, `POST .../stock/count`, `PATCH .../stock/threshold`.
**Merchant (POS, `merchant:charge` extended + new `merchant:stock_count`):** `GET /api/merchant/products`, `GET /api/merchant/products?barcode=`, `GET /api/merchant/stock`, `POST /api/merchant/stock/count`, `POST /api/merchant/charge` (now accepts `items`).

## 8. POS app (`pos-app-cashier-wt`)

- **Charge tab → basket POS**: `mobile_scanner` (already a dependency — reads EAN/UPC as well as today's QR) for barcode scan + a product-tile grid + basket + single band-tap to settle. Reuses NFC read (`tag_reader.dart`) and the "New balance: RX" receipt, now itemised.
- **Shift start**: optional "Who's on this till?" prompt → `staffName` sent with each charge.
- **Stock-take screen** on the merchant shell: list this bar's products, enter counts, submit, see variance.
- **`api.dart`**: `MerchantApi` gains `products()`, `productByBarcode()`, `stock()`, `submitCount()`; `charge()` grows an optional `items` + `staffName`.

## 9. Dashboard

- **Cashless tab → add a Stock sub-section**: live board, reconciliation, Event Stock Dashboard (charts/tables above).
- **New Catalogue / Stock management page** under the event: products CRUD (name, barcode, price, category, pack size, threshold, image), per-bar stock (receive), transfers, counts. Reuses the `apiClient` + permission-gated routing already in `dashboard/src/lib/api.ts`.

## 10. Permissions / auth

- New `TicketsPermission.MANAGE_STOCK = 'tickets:manage_stock'` (catalogue/stock/transfers) added to `OWNER` + `MANAGER` roles; `VIEW_STOCK = 'tickets:view_stock'` folded into revenue/stats viewing. Additive to the enum — not added to any unrelated role.
- Merchant token: reuse `merchant:charge` for item sales; add `merchant:stock_count` for the POS stock-take.
- **No new actor** (decision #4).

## 11. Testing (TDD; existing Jest + `mongodb-memory-server`; adversarial money-path style)

- **Sale CAS concurrency:** N parallel taps on the last unit ⇒ exactly `floor(onHand/qty)` succeed; `onHand` never negative.
- **Transaction atomicity:** an out-of-stock line rolls back the wallet debit (balance + stock both untouched on decline).
- **Idempotency:** replaying a charge (same `clientTxnId`) applies stock + money exactly once.
- **Stock-ledger property test:** random receive/sale/transfer/count sequences always leave `onHand == Σ deltas`; the §5 reconciliation identity holds.
- **Transfer safety:** can't transfer more than the source bar holds; paired movements always balance to zero net across bars.
- **Count/variance math:** `variance == counted − expected`; `count_adjust` reconciles the book to the count.
- **Un-itemised path:** amount-only charge still succeeds, records no items, deducts no stock, and is flagged in reporting.
- Reuse existing jest setup; extend `merchant.service` and `organizerCashless.service` test suites.

## 12. Build slices (for the implementation plan)

Each slice is independently testable; own PR onto the cashless line.

1. **Catalogue + stock models & service** (api) — `Product`, `ProductStock`, `StockMovement`, `StockService.post` (sole writer), organiser product/stock CRUD + receive, tests (incl. stock-ledger property test).
2. **Item sales in the charge** (api) — extend `MerchantService.charge` with line items + per-product stock CAS (hard block) + `MerchantCharge.items`/`staffName`; concurrency/atomicity/idempotency/un-itemised tests.
3. **Transfers + counts + low-stock alerts** (api) — `StockTransfer`, `StockCount`, threshold alerts via notifications, tests.
4. **Reporting** (api) — board / reconciliation / dashboard / movements endpoints, tests.
5. **POS** (pos-app) — basket POS (scan + tiles), staff-name prompt, stock-take screen, itemised receipt.
6. **Dashboard** (dashboard) — Stock sub-section on the Cashless tab + Catalogue/Stock management page.
7. **Seed + docs** — extend `seedCashlessDemo.ts` with a few products, per-bar stock, sample sales/transfers/counts; update `CASHLESS_DEMO_GUIDE.md` with a "stock" act; run on dev.

## 13. Delivery & deploy topology (unchanged)

- Fresh worktree per repo on `feat/cashless-stock` off the bases in the header. Merge onto the cashless line, not `main`.
- api: `gcloud run deploy carrot-tickets-api --source .` (prod) / dev trigger; realtime shares the image.
- dashboard: Cloudflare Pages (contracts CF account), prod branch `main`.
- pos-app: EAS/APK build shared out of band (dev points at `dev-api.carrottickets.com`).
- **Fail loudly:** every charge/stock/alert failure surfaces through the app's normal error channel — no silent fallbacks or canned success (workspace rule). Stock decline is a real 4xx the POS shows; a failed low-stock alert is logged, not swallowed.
- Run `security-pentest-reviewer` over the extended charge path before go-live (it now mutates stock as well as money).

## 14. Open questions

- **Threshold defaults:** global default low-stock threshold (e.g. 20, per the PDF) vs per-product only? Assumed: per-product `lowStockThreshold`, with an event-level default applied when unset.
- **Who resolves a variance?** Recording it is in scope; a formal write-off/approval workflow for shrinkage is deferred (organiser sees it in reporting).
- **Product images:** reuse existing R2 media upload for product thumbnails on tiles — assumed yes, minor.

## 15. Future extensions (explicitly out of scope now)

- **Org-wide product library** (scan-once reused across events) layered over the event-scoped catalogue.
- **Cash/card tender stock deduction** (stock tracking for non-NFC sales at the bar).
- **Individual staff sub-logins** under a merchant (full per-person auth vs the `staffName` label).
- **Supplier/purchase-order** side (cost price, margin, procurement) — this spec is sell-side inventory only.
