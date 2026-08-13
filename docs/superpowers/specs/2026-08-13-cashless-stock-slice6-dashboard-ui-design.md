# Cashless Stock — Slice 6: Dashboard Stock UI (Design)

**Date:** 2026-08-13
**Status:** Design — awaiting review
**Branch (base):** dashboard `feat/cashless-cashier-dashboard` (@37e033b) → `feat/cashless-stock-dashboard` (worktree `dashboard-stock-wt`). FF-merge back onto the cashless dashboard line, not `main`.
**Repos:** `dashboard` only (React/Vite, Cloudflare Pages). Consumes the already-merged Slice-1/3 organiser management endpoints + the Slice-4 report endpoints on `feat/cashless-cashier` — no API change.
**Builds on:** parent design `2026-08-12-cashless-stock-management-design.md` §9 + Slice 4 (report endpoints) + Slices 1/3 (organiser product/stock endpoints). Extends `EventCashlessTab.tsx` (the money report) and adds a Catalogue/Stock management page.

---

## 1. Why / scope

The backend + POS are done; the organiser still has no web view of stock. Slice 6 gives them two surfaces from parent §9:

**6a — Stock reporting** (read-only): a **Stock** sub-tab inside the existing **Cashless** tab (`EventCashlessTab`), consuming the four Slice-4 GET endpoints — live board, reconciliation, event stock dashboard, and a recent-movements log.

**6b — Catalogue / Stock management**: a new top-level **Catalogue** page (route `/stock`, mirroring the Vendors/Cashiers management pages) — an event picker (cashless events) → products CRUD + per-bar stock operations (receive, transfer, physical count, low-stock threshold), driven by the Slice-1/3 organiser endpoints.

**In scope (dashboard only):** the `apiClient` methods for all report + management endpoints; the Stock reporting sub-tab; the Catalogue page + product create/edit dialog + receive/transfer/count/threshold dialogs; `MANAGE_STOCK` added to the dashboard permission map + `canManageStock()` gate; a sidebar entry + route.

**Out of scope:** any API change (all endpoints exist and are ownership/permission-guarded server-side); **product image upload** (no general uploader exists in the dashboard yet — `imageUrl` is left unset in v1; deferred, called out); a chart library (peak-times/best-sellers render as tables + CSS bars, no new dependency); editing stock from anywhere but this page.

## 2. Decisions

Parent §9 locks the surfaces. Slice-6 decisions:

| # | Decision | Choice |
|---|----------|--------|
| A | Reporting placement | An **inner `Tabs` (Money · Stock)** inside `EventCashlessTab` — not a new top-level event tab. The money report stays the default; Stock is one click away. Keeps the event page's top-level tab list unchanged. |
| B | Reporting gate | **None client-side** — same as the existing money report, which renders whenever `event.cashless` and lets the API enforce `VIEW_REVENUE`. (The dashboard permission map has no `VIEW_REVENUE` entry today; adding one is out of scope.) |
| C | Management placement | A **top-level `/stock` "Catalogue" page** with a cashless-event picker, mirroring `VendorsPage`/`CashiersPage` (also per-event, also top-level with a picker). DRY with the established management-page pattern; deviates from parent §9's literal "page under the event" but matches how the sibling management pages are actually built. |
| D | Management gate | **`MANAGE_STOCK`** added to `permissions.ts` + a `canManageStock(user)` helper (super-admin OR the `tickets:manage_stock` permission, with the same "empty permissions array = full owner access" default as `hasPermission`). Gates the sidebar link + the page. The API is the real authority. |
| E | Charts | **No chart library.** Best-sellers / sales-by-bar / sales-by-employee / reconciliation = tables; peak-times + itemised-split = inline CSS bars (divs). Keeps the bundle + deps unchanged. |
| F | Product image | **Deferred** — the create/edit form omits an image field in v1 (`imageUrl` stays unset). A follow-up can add it once the dashboard has a reusable uploader. Called out so it isn't mistaken for missing. |
| G | Receive units | The receive dialog offers **units or packs** (`unit: 'unit'|'pack'`, `quantity`) exactly as the endpoint accepts; the server does the pack→unit conversion. |
| H | Data freshness | react-query `useQuery` per endpoint (keys scoped by eventId); mutations `invalidateQueries` the affected keys (board/reconciliation/products) so the board reflects a receive/transfer/count immediately, matching `VendorsPage`'s mutation pattern. |

## 3. API client additions (`dashboard/src/lib/api.ts`)

All under the existing envelope via `this.request<T>(url, opts)`. Reporting (reuses `VIEW_REVENUE`, ownership server-side):
```
events.getEventStockBoard(id)            -> GET /tickets/events/:id/stock/board
events.getEventStockReconciliation(id)   -> GET /tickets/events/:id/stock/reconciliation
events.getEventStockDashboard(id)        -> GET /tickets/events/:id/stock/dashboard
events.getEventStockMovements(id, {productId?, merchantId?, cursor?, limit?})
                                          -> GET /tickets/events/:id/stock/movements
```
Management (`MANAGE_STOCK`), a new `stock = { … }` client group:
```
stock.listProducts(eventId)                          -> GET  /tickets/events/:id/products
stock.createProduct(eventId, {name, category, price, barcode?, unitLabel?, unitsPerPack?, packLabel?})
                                                     -> POST /tickets/events/:id/products
stock.updateProduct(productId, {…partial})           -> PATCH /tickets/products/:id
stock.receive(eventId, {merchantId, productId, quantity, unit, note?})
                                                     -> POST /tickets/events/:id/stock/receive
stock.transfer(eventId, {productId, fromMerchantId, toMerchantId, qty, note?})
                                                     -> POST /tickets/events/:id/stock/transfer
stock.recordCount(eventId, {merchantId, productId, countedOnHand, phase?})
                                                     -> POST /tickets/events/:id/stock/count
stock.setThreshold(eventId, {merchantId, productId, lowStockThreshold})
                                                     -> PATCH /tickets/events/:id/stock/threshold
```
TypeScript response types mirror the Slice-4 payloads (board `{perBar, byProduct}`, reconciliation `{perBar, byProduct, total}`, dashboard `{revenueByProduct, bestSellers, salesByBar, salesByEmployee, itemisedSplit, peakTimes, variances, totalShrinkageUnits, predictedStockOut, noRecentSales}`, movements `{movements, nextCursor, hasMore}`) and the management shapes (`StockProduct`, `{onHand, movementId}`, `{transferId, fromOnHand, toOnHand}`, `{expectedOnHand, countedOnHand, variance, onHand}`). Money is ZAR cents throughout (`fmtR`).

## 4. 6a — Stock reporting sub-tab (`EventCashlessTab.tsx` + `EventStockReport.tsx`)

- Wrap the current `EventCashlessTab` body in an inner `<Tabs defaultValue="money">` with `Money` (the existing report) and `Stock` (`<EventStockReport eventId={eventId} />`, lazy-queried when the Stock tab is active).
- **`EventStockReport`** renders, top to bottom:
  1. **Live board** — a per-product aggregate (name · total on-hand · status pill in_stock/LOW/SOLD_OUT), expandable to the per-bar rows. Status colours: in_stock muted, LOW amber, SOLD_OUT red.
  2. **Dashboard metrics** — stat cards (revenue itemised vs un-itemised split with a bar; best-sellers table; sales-by-bar table; sales-by-employee table; peak-times as 24 inline bars; predicted stock-out table "≈N min to out"; total shrinkage).
  3. **Reconciliation** — a table per product (rolled up): Opening → Added → In → Out → Sold → Expected → Physical → Variance, with the grand-total row; variance negative in red.
  4. **Recent movements** — the latest page from `/stock/movements` (time · bar · product · reason · Δ · balance-after), "Load more" via `nextCursor`.
- Each section: its own `useQuery` (key `['event-stock-<section>', eventId]`), loading/empty/error states matching the money tab (a section that errors shows its own message, never blanks the whole tab). All read-only.

## 5. 6b — Catalogue / Stock management page (`StockCataloguePage.tsx`)

Mirrors `VendorsPage`: an event `Select` (cashless events only) drives everything.
- **Products table** — from `stock.listProducts`: name · category · price (`fmtR`) · barcode · pack size · active. A **+ Add product** dialog (name, category `Select`, price in rand→cents, optional barcode, unit label, units-per-pack + pack label) → `stock.createProduct`. Row click / edit opens the same dialog in edit mode → `stock.updateProduct` (incl. an Active toggle).
- **Stock operations** (per bar-product) — reachable from the page:
  - **Receive** dialog: bar `Select` + product `Select` + quantity + unit (units/packs) + note → `stock.receive`.
  - **Transfer** dialog: product + from-bar + to-bar + qty (+ note) → `stock.transfer`; the 409 "insufficient source stock" surfaces as a toast, nothing moved.
  - **Count** dialog: bar + product + counted qty → `stock.recordCount`, then toast the returned variance.
  - **Threshold**: on a bar-product, set/clear `lowStockThreshold` → `stock.setThreshold`.
- A compact **per-bar on-hand** view (reusing `getEventStockBoard`) so the organiser sees current levels while receiving/transferring. Every mutation `invalidateQueries` the board + products keys (toast on success; toast the API message on error — fail loud, no silent success).
- **Route + nav:** add `<Route path="stock" element={<StockCataloguePage />} />` (gated by `canManageStock`, mirroring how Vendors is gated) + a sidebar "Catalogue" entry shown when `canManageStock(user)`.

## 6. Permissions (`dashboard/src/lib/permissions.ts`)

- Add `MANAGE_STOCK: 'tickets:manage_stock'` to the `TicketsPermission` map (matches the API enum).
- Add `canManageStock(user)`: `user.isSuperAdmin || hasPermission(user, MANAGE_STOCK)` — using `hasPermission` (so an owner account with no `permissions` array keeps access, like `canManageAccess`). This gates the sidebar link + `/stock` route; the API still enforces per request.

## 7. Testing

- **Unit (vitest):** the pure formatting/derivation helpers new to this slice — e.g. `randToCents`/`centsToRand` for the price field, and any status→label/colour mapping — get unit tests (the repo already runs `vitest`; `src/lib/__tests__/` exists). Component-render tests are out of scope (no RTL harness established for these pages; the sibling Vendors/Cashiers pages ship without them).
- **Build gate:** `npm run build` (`tsc -b && vite build`) MUST pass — per the repo rule, `tsc --noEmit` alone misses the Pages build (`noUnusedLocals` etc.); a green `npm run build` is the real gate. `npm run lint` clean on changed files.
- **Manual/preview:** optional browser verification against a running API is possible but the API isn't deployed (cashless line is local); not required for this slice.

## 8. Delivery

- `feat/cashless-stock-dashboard` off `feat/cashless-cashier-dashboard` (worktree `dashboard-stock-wt`); FF-merge back onto the cashless dashboard line, not `main`. Not deployed (whole cashless system ships together).
- **Fail loud:** every mutation surfaces the API error via `toast.error`; a report section that errors shows its own error state; no fabricated/empty "success". The 409 (over-transfer / over-count-can't-happen) and validation 400s are shown, not swallowed.

## 9. Open questions / carry-forward

- **Product images** deferred (decision F) — revisit when a reusable dashboard uploader exists.
- **Opening/closing count phase** from the dashboard — the count dialog defaults `phase:'interim'`; an explicit opening/closing baseline selector can be added if the client wants the doors-open/close reconciliation anchored from the web (the POS also only does interim).
- Reporting `VIEW_REVENUE` isn't represented in the dashboard permission map; the Stock report tab is shown on any cashless event and relies on the server gate (matches the existing money tab). If the client wants the tab hidden for non-revenue team members, add `VIEW_REVENUE` + a gate later.
- Carry-forward from Slices 1-5 unchanged (receive/transfer not client-idempotent; etc.).
