# Cashless Stock — Slice 6: Dashboard Stock UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the organiser a web view of stock — a Stock reporting sub-tab on the Cashless tab (board / dashboard / reconciliation / movements) and a Catalogue page to manage products + per-bar stock (receive / transfer / count / threshold).

**Architecture:** React/Vite dashboard, react-query + shadcn/ui + Tailwind + sonner. New `apiClient` methods for the Slice-4 report endpoints + the Slice-1/3 management endpoints; a read-only `EventStockReport` inside `EventCashlessTab` (inner Money/Stock tabs); a `StockCataloguePage` (event picker + products CRUD + stock-op dialogs) at `/stock`, gated by a new `canManageStock`.

**Tech Stack:** React 19, Vite, TypeScript, @tanstack/react-query, shadcn/ui (Card/Table/Tabs/Dialog/Select/Input/Button/Badge), lucide-react, sonner (toast). No new deps (no chart lib).

**Spec:** `docs/superpowers/specs/2026-08-13-cashless-stock-slice6-dashboard-ui-design.md`

## Global Constraints

- **Base:** `feat/cashless-stock-dashboard` off `feat/cashless-cashier-dashboard` (worktree `dashboard-stock-wt`); FF-merge back, not `main`. No API change (endpoints already merged on `feat/cashless-cashier`).
- **Build gate:** `npm run build` (`tsc -b && vite build`) MUST pass — `tsc --noEmit` alone misses Pages-build failures (`noUnusedLocals`). `npm run lint` clean on changed files.
- **Money is ZAR cents on the wire** — display via `fmtR`; the price input converts rand→cents on submit.
- **Fail loud:** every mutation `toast.error(e.message)` on failure; a report section that errors shows its own error, never blanks the tab or fabricates data. 402/409/400 surfaced.
- **No product image upload in v1** (deferred). No client `VIEW_REVENUE` gate on the report tab (server-enforced, matches the money tab).

---

### Task 1: `apiClient` methods + types + `canManageStock`

**Files:**
- Modify: `src/lib/api.ts` (report methods on `events`, new `stock` group, response types)
- Modify: `src/lib/permissions.ts` (`MANAGE_STOCK` + `canManageStock`)
- Test: `src/lib/__tests__/money.test.ts` (rand↔cents helpers, if newly added there)

**Interfaces:**
- Produces: `apiClient.events.getEventStock{Board,Reconciliation,Dashboard,Movements}`, `apiClient.stock.{listProducts,createProduct,updateProduct,receive,transfer,recordCount,setThreshold}`, exported types (`StockBoard`, `StockReconciliation`, `StockDashboard`, `StockMovementsPage`, `StockProduct`), `canManageStock(user)`.

- [ ] **Step 1: Add response types + report methods** to `api.ts`. Types mirror the Slice-4 payloads exactly (see spec §3). Add to the `events` group:

```ts
getEventStockBoard: (id: string) =>
  this.request<StockBoard>(`/tickets/events/${id}/stock/board`),
getEventStockReconciliation: (id: string) =>
  this.request<StockReconciliation>(`/tickets/events/${id}/stock/reconciliation`),
getEventStockDashboard: (id: string) =>
  this.request<StockDashboard>(`/tickets/events/${id}/stock/dashboard`),
getEventStockMovements: (id: string, params: { productId?: string; merchantId?: string; cursor?: string; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.productId) q.set('productId', params.productId);
  if (params.merchantId) q.set('merchantId', params.merchantId);
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  return this.request<StockMovementsPage>(`/tickets/events/${id}/stock/movements${qs ? `?${qs}` : ''}`);
},
```

- [ ] **Step 2: Add the `stock` management client group** to the `ApiClient` class (mirror the `merchants` group). Confirm the exact request field names against `api-cashier-wt/src/validators/stock.validator.ts` before writing (createProduct: name/category/price/barcode?/unitLabel?/unitsPerPack?/packLabel?; receive: merchantId/productId/quantity/unit; transfer: productId/fromMerchantId/toMerchantId/qty/note?; count: merchantId/productId/countedOnHand/phase?; threshold: merchantId/productId/lowStockThreshold).

```ts
stock = {
  listProducts: (eventId: string) =>
    this.request<StockProduct[]>(`/tickets/events/${eventId}/products`),
  createProduct: (eventId: string, data: NewProduct) =>
    this.request<StockProduct>(`/tickets/events/${eventId}/products`, { method: 'POST', body: JSON.stringify(data) }),
  updateProduct: (productId: string, data: Partial<NewProduct> & { active?: boolean }) =>
    this.request<StockProduct>(`/tickets/products/${productId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  receive: (eventId: string, data: { merchantId: string; productId: string; quantity: number; unit: 'unit' | 'pack'; note?: string }) =>
    this.request<{ onHand: number; movementId: string }>(`/tickets/events/${eventId}/stock/receive`, { method: 'POST', body: JSON.stringify(data) }),
  transfer: (eventId: string, data: { productId: string; fromMerchantId: string; toMerchantId: string; qty: number; note?: string }) =>
    this.request<{ transferId: string; fromOnHand: number; toOnHand: number }>(`/tickets/events/${eventId}/stock/transfer`, { method: 'POST', body: JSON.stringify(data) }),
  recordCount: (eventId: string, data: { merchantId: string; productId: string; countedOnHand: number; phase?: string }) =>
    this.request<{ countId: string; expectedOnHand: number; countedOnHand: number; variance: number; onHand: number }>(`/tickets/events/${eventId}/stock/count`, { method: 'POST', body: JSON.stringify(data) }),
  setThreshold: (eventId: string, data: { merchantId: string; productId: string; lowStockThreshold: number | null }) =>
    this.request(`/tickets/events/${eventId}/stock/threshold`, { method: 'PATCH', body: JSON.stringify(data) }),
};
```

- [ ] **Step 3: `permissions.ts`** — add `MANAGE_STOCK: 'tickets:manage_stock'` to `TicketsPermission`, and:
```ts
export function canManageStock(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  return hasPermission(user, TicketsPermission.MANAGE_STOCK);
}
```

- [ ] **Step 4:** If a rand↔cents helper is added for the price field, put it in `src/lib/money.ts` with a vitest (`randToCents('25.00') === 2500`, `centsToRand(2500) === '25.00'`, handles blanks/NaN). Run `npx vitest run src/lib/__tests__/money.test.ts`.

- [ ] **Step 5:** `npm run build` — must pass. Commit `feat(cashless-stock): dashboard apiClient stock report + management methods + canManageStock (Slice 6)`

---

### Task 2 (6a): Stock reporting sub-tab

**Files:**
- Create: `src/components/EventStockReport.tsx`
- Modify: `src/components/EventCashlessTab.tsx` (wrap body in inner Money/Stock `Tabs`)

**Interfaces:**
- Consumes: `apiClient.events.getEventStock*`, `fmtR`, shadcn Card/Table/Tabs/Badge.
- Produces: `<EventStockReport eventId />`; `EventCashlessTab` gains an inner tab list.

- [ ] **Step 1:** In `EventCashlessTab.tsx`, extract the current report body into a `Money` tab and add `Tabs`:
```tsx
return (
  <Tabs defaultValue="money" className="space-y-4">
    <TabsList>
      <TabsTrigger value="money">Money</TabsTrigger>
      <TabsTrigger value="stock">Stock</TabsTrigger>
    </TabsList>
    <TabsContent value="money" className="space-y-6">{/* existing body */}</TabsContent>
    <TabsContent value="stock"><EventStockReport eventId={eventId} /></TabsContent>
  </Tabs>
);
```
(The existing loading/error guards stay wrapping the whole thing, or move the money-summary query into the Money content — keep it simple: keep the outer summary query as-is for the Money tab; the Stock tab has its own queries.)

- [ ] **Step 2:** `EventStockReport` — four sections, each its own `useQuery` (keys `['event-stock-board'|'-dashboard'|'-recon'|'-movements', eventId]`), each with loading/empty/error states:
  - **Board**: `byProduct` rows (name · totalOnHand · status pill), each expandable to its `perBar` rows. Status pill: `in_stock` slate, `low` amber, `sold_out` red.
  - **Dashboard**: stat row (total revenue = itemised.gross + unitemised.gross; itemised-vs-un-itemised as a two-segment bar with % ); best-sellers table (product · units · revenue); sales-by-bar table; sales-by-employee table (label · gross · count); peak-times = 24 inline vertical bars (height ∝ units); predicted stock-out table (product · bar · onHand · ≈min-to-out); total shrinkage units.
  - **Reconciliation**: `byProduct` table with columns Opening/Added/In/Out/Sold/Adjust/Expected/Physical/Variance + the `total` row; negative variance in red, `physical`/`variance` show "—" when null.
  - **Movements**: `getEventStockMovements(eventId, {limit:50})` → table (time · bar · product · reason badge · Δ signed · balanceAfter); a "Load more" button using `nextCursor` (accumulate pages in local state).

- [ ] **Step 3:** `npm run build` + `npm run lint`. Commit `feat(cashless-stock): organiser Stock report sub-tab (board/dashboard/reconciliation/movements) (Slice 6)`

---

### Task 3 (6b): Catalogue page — products CRUD + route + nav

**Files:**
- Create: `src/pages/StockCataloguePage.tsx`
- Modify: `src/App.tsx` (route), `src/components/layout/Sidebar.tsx` (nav entry)

**Interfaces:**
- Consumes: `apiClient.stock.*`, `apiClient.events.getEvents`, `apiClient.merchants.list`, `apiClient.events.getEventStockBoard`, `canManageStock`, shadcn Dialog/Select/Input/Label/Button/Card/Table/Badge, sonner.

- [ ] **Step 1:** `StockCataloguePage` scaffold — mirror `VendorsPage`: an events `useQuery` filtered to `e.cashless`, an event `Select`, `selectedEventId`. A products `useQuery` (`['stock-products', selectedEventId]`, `enabled: !!selectedEventId`).

- [ ] **Step 2:** Products table (name · category · price `fmtR` · barcode · pack · active Badge) + a **+ Add product** `Dialog`. Form fields: name (Input), category (`Select` of the ProductCategory values: beer/spirits/wine/soft_drink/water/food/merch/cigarettes/other), price (Input in rand → `randToCents` on submit), barcode (Input, optional), unit label (Input, default "unit"), units per pack + pack label (optional). `createProduct` mutation → `invalidateQueries(['stock-products', eventId])` + `toast.success`; `onError` toast. Row edit opens the same dialog pre-filled → `updateProduct` (adds an Active `Switch`/toggle).

- [ ] **Step 3:** Route + nav. In `App.tsx` add `<Route path="stock" element={<StockCataloguePage />} />` next to `vendors`/`cashiers` (match their gating — if they’re wrapped in a permission route, wrap `/stock` in a `canManageStock` guard equivalently; else rely on the sidebar gate + server). In `Sidebar.tsx` add a "Catalogue" link (lucide `Package`/`Boxes` icon) shown when `canManageStock(user)`.

- [ ] **Step 4:** `npm run build` + `npm run lint`. Commit `feat(cashless-stock): Catalogue page — product CRUD + route + nav (Slice 6)`

---

### Task 4 (6b): Stock operations — receive / transfer / count / threshold

**Files:**
- Modify: `src/pages/StockCataloguePage.tsx` (op dialogs + a per-bar on-hand panel)

- [ ] **Step 1:** A compact **per-bar on-hand** panel from `getEventStockBoard(selectedEventId)` (`['stock-board', eventId]`) — the `perBar` rows grouped by bar, each product’s onHand + status pill — so the organiser sees levels while operating.

- [ ] **Step 2:** **Receive** dialog: bar `Select` (from `merchants.list`) + product `Select` + quantity (Input) + unit (`Select` unit/pack) + note → `stock.receive`; on success invalidate `['stock-board']` + `['stock-products']`, toast onHand.

- [ ] **Step 3:** **Transfer** dialog: product + from-bar + to-bar (`Select`s, from≠to enforced) + qty + note → `stock.transfer`; invalidate board; a **409** → `toast.error('Not enough stock at the source bar')` (read `e.message`), nothing moved.

- [ ] **Step 4:** **Count** dialog: bar + product + counted qty → `stock.recordCount`; toast the returned `variance` ("Variance −3" red / "Matched" / "+2"), invalidate board.

- [ ] **Step 5:** **Threshold**: on a per-bar product row, a small "Set alert" control → `stock.setThreshold` ({merchantId, productId, lowStockThreshold}) with a clear (null) option; invalidate board.

- [ ] **Step 6:** `npm run build` + `npm run lint` + `npx vitest run`. Commit `feat(cashless-stock): Catalogue stock ops — receive/transfer/count/threshold (Slice 6)`

- [ ] **Step 7: Final gates + review + merge.** `npm run build` green, `npm run lint` clean, `npx vitest run` green; independent review of the diff; FF-merge `feat/cashless-stock-dashboard` → `feat/cashless-cashier-dashboard`.

## Self-Review checklist

- **Spec coverage:** apiClient report+mgmt methods + canManageStock (T1); Stock report sub-tab board/dashboard/reconciliation/movements (T2); Catalogue product CRUD + route/nav (T3); receive/transfer/count/threshold + per-bar levels (T4). ✅
- **Field-name accuracy:** the `stock` client bodies match `stock.validator.ts` (verified in T1 step 2). ✅
- **Fail loud:** every mutation toasts the API error; 409 transfer surfaced; report sections error independently. ✅
- **Build gate:** `npm run build` (not just tsc --noEmit) after every task. ✅
- **No new deps / no image upload / no client VIEW_REVENUE gate** (deferred per spec). ✅
