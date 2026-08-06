# Super-Admin Fees Page — Design Spec

**Date:** 2026-08-06
**Status:** Approved (design), pending implementation plan
**Repos touched:** `carrot-tickets/api` (Mongoose/Express), `carrot-tickets/dashboard` (React/Vite)
**Feature branch:** `feat/super-admin-fees`

## Problem

Super admins (Carrot platform staff) have no way to see how much money Carrot has
actually collected in fees, broken down per event. Every existing revenue
aggregation in the codebase sums `totalAmount` (face value — the **organizer's**
money). Nothing anywhere sums the fees Carrot retains. We need a dedicated
super-admin **Fees** page that answers: *"For each event, how much has Carrot
made, and where did it come from?"*

## What counts as a "fee"

Carrot collects money from each sale in two distinct ways, both already stored on
the `TicketSale` document:

| Concept | Field on `TicketSale` | Applies to | Whose money |
|---|---|---|---|
| Face value (ticket price) | `totalAmount` | all sales | Organizer |
| **Booking fee** (per-ticket: E5 MoMo / E10 Card / E5 DeltaPay; E0 cash/wallet) | `serviceFeeAmount` | **online only** (E0 otherwise) | **Carrot** |
| **Platform commission** (% of face, deducted from payout) | `platformFeeAmount` | **all sales** | **Carrot** |
| What the buyer paid | `amountCharged` | — | — |

**Carrot's take per event = `Σ serviceFeeAmount + Σ platformFeeAmount`.**

Behavioural note (intentional, not a bug): the booking fee is non-zero only on
*online* sales, while the platform commission applies to *every* channel. A
cash/POS-heavy event will legitimately show `E0` booking fee but a non-zero
platform commission. The page reflects the real economics.

### Counting rules

- Only `paymentStatus === 'completed'` sales count. Pending / failed / **refunded**
  are excluded, so the figure represents fees **actually retained**.
- All sales channels are included (online, box_office, reseller_pos, wristband).
  Non-online channels simply contribute `E0` booking fee.
- Events are included if they have ≥1 completed sale in the selected date range
  (not filtered to fee-bearing only — a platform-commission-only event still shows).

## Architecture

Pure read/reporting feature. **No schema changes.** New aggregation → new
super-admin endpoint → new dashboard page. Rides on existing patterns:
`analytics.service.ts` `revenueByEvent` (aggregation), `/admin/organizers`
(super-admin endpoint + `requireSuperAdmin` guard), `OrganizersPage.tsx`
(super-admin aggregated-data table page).

### Backend (`carrot-tickets/api`)

**New service** `src/services/fees.service.ts`, one exported function:

```
getFeesByEvent({ startDate?, endDate?, search?, page = 1, pageSize = 25 }) =>
  { data: FeeByEventRow[], totals: FeeTotals, pagination: Pagination }
```

Mongoose aggregation pipeline over `TicketSale`:

1. `$match`: `paymentStatus: 'completed'`; if `startDate`/`endDate` given, bound
   `soldAt` (fall back to `createdAt` semantics consistent with existing analytics).
2. `$group` by `{ eventId, paymentMethod }`: sum `serviceFeeAmount` (bookingFees),
   `platformFeeAmount` (platformFees), `totalAmount` (faceValue), `quantity`
   (ticketsSold), sale `count`.
3. `$group` by `eventId`: roll the method buckets up into event totals, and
   `$push` each method bucket into `byMethod[]`.
4. `$lookup` the `events` collection for `eventName` (mirror the existing
   `revenueByEvent` lookup).
5. If `search`: `$match` on `eventName` (case-insensitive regex) — after lookup.
6. `$facet`:
   - `rows`: `$sort` by `totalFees` desc → `$skip`/`$limit` (pagination).
   - `totals`: grand totals across **all** matched events (bookingFees,
     platformFees, totalFees, ticketsSold, eventCount).
   - `count`: total matched event count (for `pagination.totalPages`).

`totalFees = bookingFees + platformFees` (computed in-pipeline or in JS after).

**Types** (`src/interfaces/` or inline in the service):
`FeeMethodBreakdown { method, bookingFees, platformFees, ticketsSold }`,
`FeeByEventRow { eventId, eventName, ticketsSold, faceValue, bookingFees, platformFees, totalFees, byMethod[] }`,
`FeeTotals { bookingFees, platformFees, totalFees, ticketsSold, eventCount }`.

**Controller**: add `getFeesByEvent` handler to `tickets.controller.ts` (parses
query params, calls the service, returns `{ data, totals, pagination }`).

**Route**: `GET /tickets/admin/fees` in `tickets.route.ts`, guarded by the
existing `requireSuperAdmin` middleware (same as `/admin/organizers`).

### Frontend (`carrot-tickets/dashboard`)

**New page** `src/pages/FeesPage.tsx`, modeled on `OrganizersPage.tsx`:

- **KPI tiles** (`StatsCard` row): Total Carrot Fees · Booking Fees · Platform
  Commission · Tickets Sold — fed from the response `totals`.
- **Filter row:** `DateRangePicker` (defaults to all-time / no bound) +
  debounced (350ms) event-name search that resets page to 1.
- **Table** (shared `Table` primitives inside a `Card`, `overflow-x-auto`):
  columns *Event · Tickets · Face Value · Booking Fee · Platform Commission ·
  **Total Fees***. Numeric columns right-aligned. Each row is **expandable**
  (chevron / click) to reveal a sub-table of the per-`paymentMethod` breakdown
  (MoMo / Card / DeltaPay / Cash / Wallet → booking fee, platform fee, tickets).
- **Loading / empty states:** full-width `colSpan` row (same pattern as Organizers).
- **Pagination:** 25/page, Prev/Next, "Page X of Y · N events" label.
- **Money formatting:** `E x.xx` with 2 decimals (matches `OrganizerPayoutsPage`;
  `formatCurrency` from `chartColors.ts` strips decimals, so use a 2-dp formatter
  for fee amounts).

**Wiring:**
- `src/lib/api.ts`: new `fees` namespace → `list(params)` GET `/tickets/admin/fees`.
- `src/types/index.ts`: `FeeByEventRow`, `FeeMethodBreakdown`, `FeeTotals`,
  `FeesResponse` (mirroring `OrganizersListResponse`).
- `src/App.tsx`: `<Route path="fees" element={<AdminRoute><FeesPage /></AdminRoute>} />`.
- `src/components/layout/Sidebar.tsx`: add `{ name: 'Fees', href: '/fees', icon, show: true }`
  inside the `user?.isSuperAdmin` nav block (alongside Organizers/Settings/Resellers/Payouts).

## Auth

Super-admin only, on both ends:
- Backend route: `requireSuperAdmin` (checks `req.ticketsUser.isSuperAdmin`).
- Frontend route: `<AdminRoute>` (checks `user.isSuperAdmin`); nav item hidden
  from non-super-admins. No new `tickets:*` permission is introduced — this is
  Carrot-staff-only, matching the Organizers page precedent.

## Error handling

Follows the global "fail loudly" rule. If the aggregation query fails, the
controller returns a 5xx and the frontend surfaces the error state in the table
(no canned/placeholder fee data). Empty result → contextual empty-state row, not
a fabricated zero-filled table.

## Testing / verification

**Backend:**
- Unit/integration: seed completed sales across two events and two payment methods
  with known `serviceFeeAmount` / `platformFeeAmount`; assert per-event totals,
  `byMethod` split, and grand `totals`. Assert refunded/pending sales are excluded.
  Assert date-range bounding works.
- Assert `GET /tickets/admin/fees` returns 403 for a non-super-admin token, 200 for
  a super-admin token.

**Frontend:**
- `npm run build` (tsc -b) must pass — a green typecheck alone is insufficient
  (project convention: only `npm run build` catches Pages-build failures).
- Live pass in the dashboard preview: KPI tiles populate, table renders, row
  expand shows method breakdown, date filter narrows results, and the Fees nav
  item is present for a super-admin and absent for a vendor.

## Chosen defaults (explicitly)

- Only `completed` sales counted.
- All events with sales in range listed (not just fee-bearing).
- No "take-rate %" column in v1 (trivial to add later).
- Default sort: highest total fees first.
- Page size 25.

## Out of scope (v1)

- Drill-down to individual fee-bearing sales (chosen "Total + by method", not the
  sales-drill-down option).
- CSV export of the fees table (existing `EXPORT_REPORTS` machinery could add this
  later).
- Reseller-commission breakdown (distinct from platform fee; not requested).
