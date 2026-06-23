# Hub Detail + Operator Credential Dialog — Design

**Date:** 2026-06-23
**Status:** Approved (design); spec for review
**Builds on:** the operator User ID + PIN feature (2026-06-23-operator-userid-pin-auth).

## Problem

Two gaps surfaced after the operator-PIN feature shipped:

1. **Credentials vanish.** When an operator is created (or its PIN reset), the
   User ID + PIN are shown only in a 15-second toast. It's one-shot and easy to
   miss — the issuer needs a way to read, copy, and **print** the credentials.
   (Lost credentials can be reset, but the reveal itself must be durable.)
2. **Hubs are dead rows.** In the super-admin reseller detail, hubs are a static
   table. There's no way to drill into a hub to see its details, its sales
   analytics, or manage its operators. Reseller managers/admins have no hub view
   at all in the POS portal.

## Decisions (locked)

1. **Credential reveal** = a persistent dialog showing User ID + PIN with **Copy**
   and **Print** buttons; dismissed only on Done. Reused for create AND reset.
2. **Hub detail** = a dedicated drill-in **page** (route), not a panel or modal.
3. **Hub analytics** = headline KPIs **+ per-operator breakdown + a date-range filter**.
4. **Scope** = both the **super-admin dashboard** and the **in-portal** reseller
   manager/admin views.

## Part A — `OperatorCredentialsDialog` (dashboard, reusable)

A single reusable component used by every operator create/reset site (super-admin
Operators tab, in-portal Operators page, both hub-detail operator sections).

Props: `{ open, onClose, title, loginCode?, pin, businessName?, hubName? }`.

- Renders User ID (`loginCode`, when present) and PIN in large monospace text.
- **Copy** → `navigator.clipboard.writeText('User ID: <code>\nPIN: <pin>')`,
  with a "Copied" confirmation; on clipboard failure, surface an error (no silent
  swallow).
- **Print** → opens a popup window, writes a minimal credential-slip HTML
  (business name, hub, User ID, PIN, "Keep confidential — do not share"), calls
  `window.print()`, leaving global app CSS untouched.
- Closes only via **Done** (or explicit `onClose`); never auto-dismisses.

This replaces the credential toasts in the super-admin Operators tab (create +
reset) and the in-portal Operators page. Non-credential toasts (errors,
"operator created") stay as toasts.

## Part B — Backend: hub detail + analytics

### Shared analytics service

`HubAnalyticsService.getHubAnalytics(hubId: string, from?: Date, to?: Date)`:

- Matches `TicketSale` with `{ hubId, paymentStatus: COMPLETED }`, and when
  `from`/`to` are given, `createdAt: { $gte: from, $lte: to }`.
- KPIs: `revenue` (Σ `totalAmount`), `ticketsSold` (Σ `quantity`),
  `salesCount` (count), `operatorsCount` (count of `ResellerOperator` in the hub).
- `byOperator[]`: aggregate group by `soldBy` →
  `{ operatorId, salesCount, revenue, ticketsSold }`, then enrich each with
  `fullName` + `loginCode` from `ResellerOperator`. Operators with zero sales in
  range are included with zeroed totals (so the manager sees the full roster).

Return shape (used verbatim by both API layers and the dashboard):
```
{
  hubId, revenue, ticketsSold, salesCount, operatorsCount,
  byOperator: [{ operatorId, fullName, loginCode, salesCount, revenue, ticketsSold }]
}
```

Date handling mirrors the existing settlement endpoints' `parseDate` helper
(invalid date → 400).

### Endpoints

Super-admin (`/api/admin`, `requireSuperAdmin`):
- `GET /admin/hubs/:hubId` → `{ hub }` (single hub; 404 if missing).
- `GET /admin/hubs/:hubId/analytics?from&to` → the analytics shape above.
- (existing) `GET/POST /admin/hubs/:hubId/operators` — unchanged.

Portal (`/api/reseller`, gated + scope-enforced):
- `GET /reseller/hubs` (gate `VIEW_HUB_SALES`) → hubs in scope
  (`reseller_admin` → all hubs for `resellerId`; `reseller_hub_manager` → only
  its own `hubId`).
- `GET /reseller/hubs/:hubId` (gate `VIEW_HUB_SALES`) → `{ hub }`, scoped (404 if
  outside scope).
- `GET /reseller/hubs/:hubId/analytics?from&to` (gate `VIEW_HUB_SALES`) →
  analytics, scoped (404 if outside scope).
- `GET /reseller/operators?hubId=<id>` — extend the existing operator-list
  endpoint with an optional `hubId` filter, validated to be within the actor's
  scope (admin: hub must belong to its reseller; hub_manager: must equal its own
  hub, else the filter is ignored/forbidden). Used by the hub-detail operators
  section. Create/reset reuse the existing portal operator endpoints.

Scope checks reuse the Task-6 pattern (derive from `req.reseller`, never client).

## Part C — Frontend: clickable hubs → drill-in pages

### Super-admin

- In `ResellerDetailPage`'s `HubsTab`, hub rows become clickable (cursor-pointer +
  hover) → navigate to `/resellers/:id/hubs/:hubId`.
- New route + page `HubDetailPage` (super-admin):
  - Back link to the reseller.
  - Hub info header (name, location, status).
  - **Analytics section**: a `DateRangePicker` (existing component) + KPI
    `StatsCard`s (revenue, tickets sold, sales, operators) + a per-operator table
    (name, User ID, sales, tickets, revenue). Refetches on range change; empty
    range = all-time.
  - **Operators section**: lists the hub's operators (existing
    `listOperators(hubId)`), Add Operator (existing `createOperator(hubId,…)`)
    using `OperatorCredentialsDialog`, and Reset PIN (existing
    `resetOperatorPin`) also via the dialog.

### In-portal

- POS header gains a **Hubs** link for roles with `VIEW_HUB_SALES`
  (`reseller_admin`, `reseller_hub_manager`).
- New route `/reseller/hubs` → portal `ResellerHubsPage`: lists hubs in scope
  (clickable) → `/reseller/hubs/:hubId` → portal `ResellerHubDetailPage` with the
  same three sections (info, analytics + date range, operators). Operators
  section uses the portal endpoints (`GET /reseller/operators?hubId`,
  `POST /reseller/operators`, `POST /reseller/operators/:id/reset-pin`) and the
  shared `OperatorCredentialsDialog`. A hub_manager landing on `/reseller/hubs`
  sees only its own hub.

### Dashboard API clients

- `apiClient.resellerAdmin`: add `getHub(hubId)`, `getHubAnalytics(hubId, from?, to?)`.
- `resellerOperatorsApi` / a new `resellerHubsApi`: add `listHubs()`,
  `getHub(hubId)`, `getHubAnalytics(hubId, from?, to?)`, and `listOperators(hubId)`
  (the `?hubId` variant).
- A shared `HubAnalytics` TS type matching the service shape.

## Error handling

All new fetches surface failures via toast/error state (project rule: no silent
fallbacks). Clipboard and print failures surface an error toast. Out-of-scope hub
access returns 404 (no enumeration).

## Testing

API (Jest): `HubAnalyticsService` (KPI sums, per-operator grouping, date-range
filter, zero-sales operators included); super-admin hub get + analytics routes;
portal hub list/get/analytics scope tests (hub_manager sees only its hub; admin
scoped to reseller; cross-reseller → 404; operator role → 403); `?hubId` operator
filter scope. Dashboard: tsc + vite build (no unit tests in repo).

## Out of scope

- Charts/time-series (KPIs + table only).
- Editing hub info from the detail page (rename/deactivate) — view + operators only.
- Caching/pagination of analytics (datasets are small per hub).
