# Per-event currency selection (display + settlement)

**Date:** 2026-08-13
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/event-currency-selection` (isolated worktree per repo — `api`, `dashboard`, `landing`, `pos-app` — each off its repo's current prod branch; exact base branches pinned in the implementation plan)

## Problem

Every price in Carrot Tickets renders a hardcoded Emalangeni symbol (`E`), even
though the platform already serves — and wants to serve more — events denominated in
South African Rand (`R`). An organizer running a South African event should be able to
**choose the currency their event is presented in** (e.g. `R` instead of `E`), and that
choice should flow through every buyer, organizer, accounting, and POS surface.

The groundwork half-exists: the `Event` model already carries a `currency` field
(`'SZL' | 'ZAR'`, default `'SZL'`) with a validator, service plumbing, and a form
`<select>` — but it is **deliberately gated to external (link-out) events only**. For
Carrot-sold events the field is dropped on submit and never read; ~48 sites hardcode `E`.

## Currency reality (why this is safe)

- **SZL (E) and ZAR (R) are pegged 1:1** under the Common Monetary Area. `E100 === R100`.
  No FX conversion ever happens.
- Each **payment rail settles in one fixed native currency**: MTN MoMo → `SZL`, Peach
  (card) → `ZAR`, DeltaPay → `SZL`. The post-payment verify/reconcile guards reject a
  sale whose callback currency ≠ that rail-native code — this is the safety check behind
  past "charged-but-no-ticket" incidents and **must not be disturbed**.
- Therefore the organizer's currency choice is a **display/denomination** concern, not a
  money-movement one. Settlement currency is whatever the rail natively uses.

## Decisions (locked)

1. **Two currencies, cleanly separated.**
   - **Display currency** = `event.currency` (`'SZL' | 'ZAR'`, default `'SZL'`), the
     organizer's choice. Drives *all* `R`/`E` rendering.
   - **Settlement currency** = the rail-native code the charge actually used, **recorded
     per sale** on `ticketSale.settlementCurrency`. Rail-determined (not organizer-chosen),
     surfaced in finance/reconciliation views.
   - The two may legitimately **differ**: a `ZAR` event paid via MoMo settles in `SZL` at
     par, and the books record that truthfully.
2. **Currencies offered: `SZL` (E) and `ZAR` (R) only.** Matches the existing model enum
   and the rails' capabilities. (YAGNI: no USD/other — the Eswatini rails cannot settle
   non-CMA currencies.)
3. **Reach: core event views + platform accounting + native POS.** Buyer, organizer,
   super-admin/reseller accounting, receipts/tickets, and the Flutter POS all follow the
   event's display currency.
4. **Payments untouched.** Gateway request currencies and the verify/reconcile guards are
   unchanged. We only *persist* the settlement currency each rail already uses. No payment
   method is removed; DeltaPay keeps working for every event.
5. **No data migration.** Existing rows default to `SZL`, which is the *correct* historical
   value (every past event/sale was in Emalangeni) — not a backward-compat shim.

## Scope: what is (and isn't) affected

**In scope**
- Un-gate the currency picker so **Carrot-sold** events can set it (today it only renders
  for `ticketing === 'external'`).
- Snapshot display currency onto `ticketSale` and `ticket`; record `settlementCurrency`
  on `ticketSale`.
- Route every event-price render through a currency-aware formatter (dashboard, landing,
  api receipts/SMS/email, POS).
- Surface `settlementCurrency` in finance/reconciliation accounting surfaces.

**Out of scope (deliberate)**
- **Payment-rail currency codes and verify/reconcile guards** — unchanged (Decision 4).
- **The cashless / wallet "ZAR-cents" system** (`fmtR` in `EventCashlessTab.tsx`,
  `CashierDetailPage.tsx`, `VendorDetailPage.tsx`, `TransactionDetailDialog.tsx`) — an
  independent wristband-wallet feature hardwired to ZAR cents. Not part of ticket
  currency; not touched.
- **Transport / bus vertical** (`api/src/services/transport/booking.service.ts`,
  bus POS) — a separate product surface (operator-sold bookings), currently unmerged PRs.
  Flag for a follow-up pass if wanted; not in this change.
- **Cross-event aggregate totals** are rendered in the platform base **E**, not per-event
  (see Design §3, "Aggregate rule").
- **Per-ticket-type currency** — currency stays event-level only (no per-tier currency).

## Design

### 1. Data model & persistence

**`api/src/models/event.model.ts` (currency at :151-163)** — unchanged. `currency`
(`enum ['SZL','ZAR']`, default `'SZL'`) is the **display currency**. Update the doc
comment in `api/src/interfaces/event.interface.ts:67-73` to drop "external events only".

**`api/src/models/ticketSale.model.ts`** — add two fields:
- `currency: { type: String, enum: ['SZL','ZAR'], default: 'SZL' }` — snapshot of the
  event's display currency at sale time (so reports render correctly even if the organizer
  later changes the event currency).
- `settlementCurrency: { type: String }` — the rail-native code the charge used. Set at
  finalization to the exact value the verify guard already checks (below). Omitted/`null`
  for free/comp tickets (no money moved).

**`api/src/models/ticket.model.ts` (price snapshot at :31)** — add
`currency: { type: String, enum: ['SZL','ZAR'], default: 'SZL' }` so a printed stub /
receipt is self-contained.

Where each is written, in `api/src/services/ticket.service.ts`:
- Snapshot `currency = event.currency` when minting tickets / building the sale.
- `settlementCurrency` mirrors the rail default already in code:
  - MoMo — `process.env['MTN_MOMO_CURRENCY'] || 'SZL'` (see :1209 / guard :1651)
  - Peach card — `process.env['CARD_CURRENCY'] || 'ZAR'` (see :1351 / guard :1793)
  - DeltaPay — `'SZL'` (SZL-native client, `deltapay.client.ts`)
  - Keshless wallet / cash / POS — platform base `'SZL'`
  Exact write sites (the `sellTickets` path + MoMo/card/DeltaPay finalizers) pinned in the
  implementation plan.

**Validators** — `api/src/validators/tickets.validator.ts` already allows
`Joi.string().valid('SZL','ZAR')` on create (:225-230) and update (:268-272). No change.

**Service** — `api/src/services/event.service.ts:76-109` already persists
`currency: params.currency ?? 'SZL'`. No change.

### 2. Un-gating the picker (dashboard)

The gate lives in two spots and must open for Carrot-sold events:

- **`dashboard/src/lib/ticketing.ts` `buildExternalPricePayload()` (:94-107)** — returns
  `{}` for `carrot` events (:100), dropping `currency`. Split responsibilities: **always**
  include `currency` in the create/update payload; keep `priceMin`/`priceMax` external-only.
  (Rename to reflect it's no longer external-only, e.g. `buildPricePayload`.)
- **`dashboard/src/pages/EventsPage.tsx`** — the currency `<select>` (:299-308) sits inside
  the `ticketing === 'external'` block (:278). Move it out so all events see it. State at
  :75-77, reset :96-99, submit merge :235 already carry `currency`.
- **`dashboard/src/pages/EventDetailsPage.tsx`** — mirror the same un-gating on the edit
  form (currency select :605-606, payload merge :201).

`priceMin`/`priceMax` remain external-only (the typed range for link-out events). Submit
path is unchanged: `createEvent.ts` → `api.ts:341-346` `POST /tickets/events` →
`tickets.route.ts:184-188` → `TicketsController.createEvent` → `event.service.createEvent`.

### 3. Display layer — one formatter per app, threaded everywhere

**Consolidate (DRY).** Each app already has a `lib/currency.ts` with
`currencySymbol(currency) => 'R' | 'E'`. Make it the single money formatter for that app:

```ts
// dashboard/src/lib/currency.ts and landing/src/lib/currency.ts
export function currencySymbol(currency: EventCurrency): string        // 'ZAR' → 'R', else 'E'
export function formatMoney(amount: number, currency: EventCurrency): string
export function formatMoneyRange(min: number, max: number, currency: EventCurrency): string
```

Then refactor the two current hardcoders to delegate and **require** a currency:
- **`landing/src/lib/pricing.ts:58` `formatAdmissionPrice()`** — takes `currency`, returns
  `formatMoneyRange(...)` instead of `E${min}…`.
- **`dashboard/src/lib/chartColors.ts:125-132` `formatCurrency()`** — drop the
  `Intl.NumberFormat('…','USD').replace('$','E ')` hack; delegate to `formatMoney`.

**Required-argument rule (no silent fallback).** Wherever an event is in scope, the
formatter takes that event's `currency` as a **required** argument — no defaulting to
`SZL` at those call sites. A default currency survives only in genuinely event-less
contexts (see Aggregate rule). This matches the "fail loudly, no silent fallbacks" rule.

**Thread `event.currency` through every price render** (~48 sites). Grouped:

- **Buyer (landing):** `components/EventCard.tsx` (:110-111 Carrot branch), `PurchaseModal.tsx`
  (:426,432,438,628-633 — subtotal, service fee, total, "Pay …" buttons), `PrintableTicket.tsx:59`,
  `components/discover/DiscoverGrid.tsx:42`, `pages/CalendarPage.tsx:21`, `lib/pricing.ts`.
- **Organizer (dashboard):** `pages/DashboardPage.tsx:91`, `EventsPage.tsx:246`,
  `EventDetailsPage.tsx:685,854,876`, `TicketSalesPage.tsx:128,226,237`,
  `SalesHistoryPage.tsx:211`, `components/EventCreatorTab.tsx:106,145`,
  `components/TicketSuccessDialog.tsx:122`, `lib/ticketReceipt.ts:111,112,183`,
  `EventAnalyticsTab` (via `formatCurrency`).
- **Accounting (dashboard):** `FeesPage.tsx:14,148,164`, `OrganizerPayoutsPage.tsx:126-147`,
  `HubDetailPage.tsx:98`, `ResellerDetailPage.tsx:480,654,703`,
  `reseller/ResellerPosPage.tsx:518,657,665,701`, `reseller/ResellerPayoutsPage.tsx`,
  `ResellerSalesHistoryPage.tsx`, `ResellerReportsPage.tsx`, `ResellerHubDetailPage.tsx:100`,
  and the `formatCurrency` consumers (`AnalyticsPage`, `OrganizersPage`, `UsersPage`).
- **API:** `services/email.service.ts` and `services/sms.service.ts:119` — if a message
  includes a price, render from the sale's snapshot `currency`. `scripts/seedSalesData.ts`
  is seed-only (leave `E`).

**Aggregate rule.** A **per-event** accounting row (this event's fees/payout/revenue) uses
that event's display currency. A **cross-event aggregate** (e.g. "total platform fees
across all events", mixed E and R) has no single currency — render it in the platform base
**E**, because Carrot's own books are in Lilangeni. This is the one place the event symbol
is deliberately not stamped.

### 4. Settlement currency in finance surfaces

`ticketSale.settlementCurrency` (from §1) is surfaced wherever reconciliation/finance needs
the truth of what settled — primarily the super-admin fees and reconciliation views. Where a
sale's `settlementCurrency` differs from its display `currency` (e.g. display `R`, settled
`E` via MoMo), show the settled value so finance is honest. Display-facing organizer/buyer
figures continue to use the display `currency`.

### 5. Native POS (Flutter)

`pos-app/lib/printer.dart:47` and `pos-app/lib/pages/pos_page.dart:50` each define a
`_money()` helper hardcoding `'E '`. Thread the event's display currency into them so
receipts/prices print `R`/`E`. The POS loads event data when selling/scanning; the exact
place the Dart event model carries currency is pinned in the implementation plan. **The Dart
is written but the app is not built** — on-device verification needs a build requested
explicitly (per workspace rule: never build the Flutter app unasked).

## Edge cases

- **Existing events / sales:** default `SZL` = correct historical value. No migration; no
  behaviour change for E events.
- **Display ≠ settlement:** intended. `ZAR` event via MoMo → `currency: 'ZAR'`,
  `settlementCurrency: 'SZL'`. Amount identical at par; both recorded.
- **Free / comp tickets:** no money moved → `settlementCurrency` omitted; display `currency`
  still snapshotted so the stub renders correctly.
- **Organizer changes event currency after sales exist:** past sales/tickets keep their
  snapshot; only future sales pick up the new currency. Reports stay historically accurate.
- **Cross-event aggregates:** rendered in base `E` (Aggregate rule) — never a mislabelled
  sum of mixed E/R.
- **Cashless wallet (`fmtR`):** untouched; remains ZAR-cents, independent of event currency.

## Testing (TDD)

- **API — currency persistence:** create & update a **Carrot-sold** event with
  `currency: 'ZAR'` persists it (guards against the old external-only gate); default is
  `'SZL'`; validator rejects a bad code.
- **API — snapshots:** a finalized sale records `currency` = event display currency and
  `settlementCurrency` = the rail-native code (MoMo→`SZL`, card→`ZAR`, DeltaPay→`SZL`);
  free ticket → no `settlementCurrency`.
- **Formatters (dashboard + landing):** `currencySymbol`, `formatMoney`, `formatMoneyRange`
  for both `SZL` (`E…`) and `ZAR` (`R…`); rounding preserved.
- **Component:** an event card / checkout for a `ZAR` event renders `R`; an `SZL` event
  renders `E`.
- **Manual E2E:** create a `ZAR` event in dashboard → buyer sees `R` on card, checkout,
  "Pay R…" → ticket/receipt shows `R` → organizer sales & fees rows show `R` → super-admin
  reconciliation shows `settlementCurrency` truthfully.

## Rollout

Deploy order: **api** (`gcloud run deploy carrot-tickets-api --source .`, env preserved) →
**dashboard** + **landing** (Cloudflare Pages, direct-upload / branch push per each repo's
convention). No DB migration. **POS** deferred to an explicit build request.

## Rejected alternatives

- **Force each gateway's transmitted currency code to the event currency** (drive settlement
  end-to-end) — rejected: buys nothing given the 1:1 peg, forces a per-gateway capability
  matrix (MoMo/DeltaPay are SZL-wired → would block ZAR events), and reworks the fragile
  verify/reconcile guards behind past charged-but-no-ticket incidents. Recording the
  rail-native settlement currency delivers "both display and settlement" safely.
- **Organizer picks a settlement currency too** (disable incompatible methods) — rejected:
  adds UI + enforcement, removes payment options, and the peg makes it pointless.
- **Additional currencies (USD, …)** — rejected as YAGNI; rails can't settle non-CMA money.
- **A shared cross-app currency package** — rejected: `dashboard` and `landing` are separate
  builds with no shared-package setup; a single `currency.ts` per app is the pragmatic DRY
  boundary. One `currency.ts` per app, each the sole formatter within its app.
- **Per-ticket-type currency** — rejected; currency is an event-level property.
