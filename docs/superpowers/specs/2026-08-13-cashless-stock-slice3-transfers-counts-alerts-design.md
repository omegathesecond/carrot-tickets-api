# Cashless Stock — Slice 3: Transfers, Counts & Low-Stock Alerts (Design)

**Date:** 2026-08-13
**Status:** Design — awaiting review
**Branch (base):** `feat/cashless-stock-transfers` off `feat/cashless-cashier` @5160fbb (Slices 1+2 merged), worktree per repo. Merge onto the cashless line, not `main`.
**Repos:** `api` only (backend). POS/dashboard UI is Slices 5/6.
**Builds on:** the parent design `2026-08-12-cashless-stock-management-design.md` (§6.3 transfers, §6.4 counts, §6.5 alerts) + Slice 1 (`StockService.applyMovement`, `ProductStock` with `lowStockThreshold`/`lowStockAlertedAt`) + Slice 2 (the item-sale charge, whose post-commit is where an alert fires).

---

## 1. Why / scope

Slice 1 loads stock and Slice 2 sells it. Slice 3 adds the three stock-control operations from the vision that keep the numbers honest during an event:

1. **Bar-to-bar transfers** — move N units of a product from one bar to another, with a full audit (who/from/to/when).
2. **Physical counts** — a stock-take records counted-vs-expected and reconciles the book to reality, preserving the **variance** (shrinkage/breakage/theft signal).
3. **Low-stock alerts** — when a sale drops a bar-product to/below its threshold, notify the organizer once.

All three compose Slice 1's sole-writer `StockService.applyMovement`, so the `onHand == Σ(movement deltas)` invariant continues to hold by construction. In scope (api only): the models, services, organizer endpoints, the POS stock read + count endpoints, and the alert plumbing. **Out of scope:** the reporting/reconciliation *views* (Slice 4 — this slice only *records* transfers/counts/variances), POS/dashboard UI (Slices 5/6), and a generic spoilage/manual write-off endpoint (a physical count already captures shrinkage as negative variance).

## 2. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Transfer atomicity | A transfer is **one transaction** = `applyMovement(TRANSFER_OUT, −qty, source)` + `applyMovement(TRANSFER_IN, +qty, dest)` on the same session. The source-side CAS (`onHand ≥ qty`) means an over-transfer throws `StockDeclinedError` and nothing moves. |
| 2 | Transfer decline mapping | Source-insufficient → **HTTP 409** `{ reason:'insufficient_stock', productId, available }` (consistent with the sale's out-of-stock 409), from the organizer transfer endpoint. |
| 3 | Count semantics | `variance = countedOnHand − expectedOnHand` where `expected = onHand` read **inside the count's transaction**; if `variance ≠ 0` apply a single `COUNT_ADJUST` movement of `variance` (a negative variance is a CAS-safe decrement bounded by `expected`, so it can't underflow); the `StockCount` row is recorded regardless (even variance 0). |
| 4 | Who counts | Organizer (any bar, via dashboard) **and** the bar itself (via POS, scoped to its own `merchantId`). |
| 5 | POS stock permission | **Reuse `MerchantPermission.CHARGE`** for `GET /api/merchant/stock` and `POST /api/merchant/stock/count` — the merchant model has no permission matrix and every bar that can charge can read/count its own stock, so a dedicated `stock_count` perm would always be granted (YAGNI). (Deviates from the parent spec's proposed `merchant:stock_count`; called out here.) |
| 6 | Low-stock alert timing | **Post-commit, best-effort, off the money path.** After a successful itemised charge, the merchant controller fires `StockAlertService.evaluateAfterSale(...)` fire-and-forget (`.catch(log)`), so a notification failure never affects the sale (workspace rule: alert is operational, not vital — but its failure is logged loudly, never silently swallowed). |
| 7 | Alert arming | Fired **once per downward crossing**, gated by `lowStockAlertedAt`: a sale that atomically sets `lowStockAlertedAt` (from `null`, when `onHand ≤ lowStockThreshold`) fires; a later replenish (receive/transfer-in/count-up above threshold) clears the marker to re-arm. `lowStockAlertedAt`/`lowStockThreshold` are NOT part of the movement journal, so they're written by a direct `ProductStock.updateOne` (not `applyMovement`). |
| 8 | Idempotency | Transfers/counts are organizer/bar-initiated and **not client-idempotent in v1** (fresh `refId` per call), consistent with the Slice-1 receive deferral. (A double-submitted *count* is naturally convergent — the second count sees the adjusted `onHand`, computes variance 0, writes no movement. A double *transfer* moves 2×qty — flagged as a v1 caveat.) |

Units unchanged: stock integer base units.

## 3. Data models (new — `src/models/`)

**`StockTransfer`** — `src/models/stockTransfer.model.ts`
```
{ eventId, productId, fromMerchantId → Merchant, toMerchantId → Merchant,
  qty: int > 0, byType: 'Organizer'|'Merchant'|'Platform', by: string, note?, at: Date }
index { eventId: 1, at: -1 }, { productId: 1, at: -1 }
```

**`StockCount`** — `src/models/stockCount.model.ts`
```
{ eventId, merchantId → Merchant, productId → Product,
  expectedOnHand: int, countedOnHand: int (≥0), variance: int,   // counted − expected
  phase: 'opening'|'interim'|'closing', byType, by: string, at: Date }
index { merchantId: 1, productId: 1, at: -1 }, { eventId: 1, phase: 1, at: -1 }
```

No new fields on `ProductStock` (Slice 1 already has `lowStockThreshold`/`lowStockAlertedAt`). No new fields on `MerchantCharge`.

## 4. Services (new — `src/services/`)

**`StockTransferService.transfer({ eventId, productId, fromMerchantId, toMerchantId, qty, byType, by, note? })`**
- Validate `fromMerchantId ≠ toMerchantId`, `qty > 0` integer. (Caller has already verified both merchants + the product belong to the event.)
- Own a `session.withTransaction`; mint `transferId = new ObjectId()`:
  - `applyMovement({ merchantId: fromMerchantId, delta: −qty, reason: TRANSFER_OUT, refType:'stock_transfer', refId: transferId, session, ... })` → throws `StockDeclinedError` if the source lacks stock ⇒ whole transfer aborts.
  - `applyMovement({ merchantId: toMerchantId, delta: +qty, reason: TRANSFER_IN, refType:'stock_transfer', refId: transferId, session, ... })`.
  - `StockTransfer.create([{ _id: transferId, ... }], { session })`.
- After commit, best-effort `StockAlertService.rearm(toMerchantId, productId)` (a transfer-in may lift the dest above threshold).
- Returns `{ transfer, fromOnHand, toOnHand }`.

**`StockCountService.recordCount({ eventId, merchantId, productId, countedOnHand, phase, byType, by })`**
- Own a `session.withTransaction`; read `expected = StockService.getOnHand(merchantId, productId, session)`; `variance = countedOnHand − expected`; mint `countId`:
  - if `variance ≠ 0`: `applyMovement({ merchantId, productId, delta: variance, reason: COUNT_ADJUST, refType:'stock_count', refId: countId, session, ... })`.
  - `StockCount.create([{ _id: countId, expectedOnHand: expected, countedOnHand, variance, phase, ... }], { session })`.
- After commit, best-effort `StockAlertService.rearm(merchantId, productId)` (a count-up may lift above threshold).
- Returns `{ count, onHand: countedOnHand }`.

**`StockAlertService`** — `src/services/stockAlert.service.ts` (the alert plumbing; notifications are best-effort)
- `evaluateAfterSale({ eventId, vendorId, merchantId, productIds })`: for each product, **atomically arm-and-detect**:
  ```
  ProductStock.findOneAndUpdate(
    { merchantId, productId, lowStockThreshold: { $ne: null }, lowStockAlertedAt: null,
      $expr: { $lte: ['$onHand', '$lowStockThreshold'] } },
    { $set: { lowStockAlertedAt: new Date() } }, { new: true })
  ```
  On a match (fires exactly once — the `lowStockAlertedAt: null` guard makes concurrent evaluations race-safe), best-effort `NotificationService.create('vendor', vendorId, 'low_stock', title, body, { productId, merchantId, onHand, threshold })`. Each product wrapped so one failure/one product can't stop the others; overall the method never throws into its caller.
- `rearm(merchantId, productId)`: `ProductStock.updateOne({ merchantId, productId, lowStockAlertedAt: { $ne: null }, $expr: { $gt: ['$onHand', '$lowStockThreshold'] } }, { $set: { lowStockAlertedAt: null } })` — clears the marker once stock is back above threshold, so the next downward crossing re-alerts. Best-effort.

## 5. Notification type

Add `'low_stock'` to `NotificationType` in `src/models/notification.model.ts` in **all three** required places: the union type, the schema `type` enum array, and `NotificationDispatcher.PREF_BY_TYPE` (`src/services/notificationDispatcher.service.ts` — the exhaustive `Record<NotificationType,…>` won't compile otherwise; map it like the existing vendor-only `follow` entry, since `low_stock` is vendor-addressed and bypasses the buyer dispatcher).

## 6. Endpoints

**Organizer (`/api/tickets`, `MANAGE_STOCK`, event-ownership via `loadOwnedEvent`), added to the Slice-1 block in `tickets.route.ts` + `StockAdminController`:**
- `POST /events/:eventId/stock/transfer` `{ productId, fromMerchantId, toMerchantId, qty, note? }` → `{ transfer, fromOnHand, toOnHand }`; source-insufficient → 409. Both merchants + product must belong to the event (existing cross-entity guard) else 400.
- `POST /events/:eventId/stock/count` `{ merchantId, productId, countedOnHand, phase? }` → `{ count, onHand }`.
- `PATCH /events/:eventId/stock/threshold` `{ merchantId, productId, lowStockThreshold: int≥0 | null }` → sets the threshold on the `(merchant,product)` `ProductStock` row (upsert if absent) and **clears `lowStockAlertedAt`** (re-arm). `null` disables alerts for that bar-product.

**POS / merchant (`/api/merchant`, `authenticateMerchant` + `requireMerchantPermission(CHARGE)`), added to `merchant.route.ts` + `MerchantController`; `merchantId` from the JWT only:**
- `GET /stock` → this bar's products with `onHand`/`lowStockThreshold`/status, for the stock-take screen (Slice 5). Read-only.
- `POST /stock/count` `{ productId, countedOnHand, phase? }` → delegates to `StockCountService.recordCount` with `merchantId` from the token, `byType:'Merchant'`.

## 7. Wiring the alert into the sale (Slice 2 charge)

In `src/controllers/merchant.controller.ts`, after a successful `MerchantService.charge` that carried items, fire-and-forget:
```ts
if (result.charge.items?.length) {
  StockAlertService.evaluateAfterSale({
    eventId, merchantId, vendorId: String(event.vendorId),
    productIds: result.charge.items.map((i) => String(i.productId)),
  }).catch((err) => console.error('[low-stock] evaluateAfterSale failed', err));
}
```
This is post-commit (the charge already returned its result), best-effort, and off the money path — a notification failure logs loudly but never affects the sale. The `MerchantService.charge` transaction itself is **unchanged** (no alert logic inside the money path). Re-arm on replenish is called from the receive (Slice 1), transfer, and count handlers after their movement applies.

## 8. Testing (TDD; `connectLedgerTestDb`; adversarial where money/stock atomic)

- **Transfer:** moves qty from A to B (A −qty, B +qty), writes paired movements + a `StockTransfer`; source-insufficient → `StockDeclinedError`/409 with nothing moved (A and B both unchanged); `from == to` and cross-event merchant/product → 400.
- **Count:** counted<expected records negative variance + a `COUNT_ADJUST` that sets `onHand = counted`; counted==expected records variance 0 and writes NO movement; the `StockCount` row is always written; a POS count is scoped to the token's `merchantId`.
- **Alert:** a sale dropping `onHand ≤ threshold` creates exactly one `low_stock` vendor notification (`recipientType:'vendor'`, `recipientId = event.vendorId`); a second sale below threshold creates NO second notification (armed); a replenish above threshold re-arms so a later dip alerts again; a product with no threshold never alerts; an alert failure never fails the sale (charge still 200).
- **Threshold endpoint:** setting a threshold clears `lowStockAlertedAt`; `null` disables.
- **Permissions/ownership:** organizer endpoints require `MANAGE_STOCK` + ownership; POS endpoints require a merchant token and are scoped to its bar.
- Reuse the existing harness; run the full suite with `--maxWorkers=4`.

## 9. Delivery

- Fresh worktree on `feat/cashless-stock-transfers` off `feat/cashless-cashier` @5160fbb. Merge onto the cashless line.
- Deploy topology unchanged. **Fail loudly:** transfer/count declines are real 4xx; the ONLY best-effort path is the low-stock notification (logged on failure, never swallowed silently, never affecting the sale).

## 10. Open questions

- **Alert channel:** v1 sends an in-app organizer notification (`low_stock`). SMS/email escalation is out of scope (can layer on later via YeboLink if the client wants it).
- **Transfer idempotency:** deferred with the Slice-1 receive-idempotency item; revisit when the dashboard wires the transfer button (an optional client-supplied `refId` uniqueness key).
