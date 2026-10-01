# Venue trading — day-to-day cashless and stock, without tags

**Date:** 2026-10-01
**Status:** design approved in chat (§1–§5); spec awaiting review

## What a venue is

A venue is a bar, restaurant or lounge that uses Carrot every day, not for one
event. It wants the cashless side — stalls, a catalogue, waiters running tables,
a till — and the stock side — receiving, transfers, stock-takes, reconciliation —
to run its normal trading.

The difference from an event is the patron. **Nobody carries a tag.** There is
no wallet, no top-up, no balance. When a bill is paid, the waiter or till
records HOW it was paid: cash, or the venue's own card machine. Carrot never
holds venue money; a venue sale is a record of payment, not a movement of funds
through the cashless ledger.

A venue is also a social actor. It signs up through its own Venue tab, uses the
same dashboard as an organizer, and posts, follows and messages exactly as an
organizer does today.

## Decisions taken, and why

**A venue is a `Vendor` with its own sign-up tab.** `Vendor.businessType`
already allows `'venue'` and the organizer register endpoint already accepts
it — the label exists, nothing uses it. Making the venue a Vendor gives it the
whole social side for free; a separate account type would have to re-earn every
social surface.

**Venue trading is switched on by a Carrot super-admin**, the same pattern as
an admin granting cashless to an event. Carrot bills venues off-platform, so
the system records no fees; the switch is the commercial gate.

**One location per venue account (v1).** Trading settings live on a separate
`Venue` document rather than on the Vendor, so a second branch later is a
second `Venue`, not a schema change — but the UI shows exactly one.

**Venues and events share one stock engine.** Stalls, catalogue, stock, staff
and tables belong to EITHER an event OR a venue. Two alternatives were
rejected:
- *A hidden "house event" per venue.* The cashless controllers gate on
  `event.status === PUBLISHED && event.cashless`, so the house event would
  have to be published — and every one of the ~78 public `Event` queries
  (Discover, calendar, search, feeds, organizer lists) would have to exclude
  it. That fails OPEN: miss one and a restaurant appears on Discover as an
  event. It also needs fake dates on fields that are required.
- *A venue-only copy of the stall/stock/table models.* Duplicates the stock
  engine; every future stock fix lands twice.

**Separate worlds from events (v1).** A venue that hosts an event creates a
normal event, with that event's own stalls and stock. Nothing is shared between
the venue's daily trading and its events.

**Card means the venue's own machine.** Carrot records "paid by card" and an
optional slip reference. It does not process the card.

**Sales come from waiter tables AND the till.** Both are tagless.

**Tables run a tab; orders go to the stall immediately.** Unlike event tables
(pay first, hand over after), a venue round is sent to the bar or kitchen the
moment the waiter adds it. The stall hands it out; the waiter accepts it; the
bill is paid at the end.

**A bill can be split by guest and paid with mixed tenders.** This is a
deliberate departure from `2026-09-05-waiter-tables-design.md`, which rejected
partial settlement as a first cut. It applies to VENUE tables only; event
tables keep their all-or-nothing tag settlement unchanged.

**Tips are recorded per tender.** A card tip is keyed on the card machine and
lands in the card batch; a cash tip lands in the drawer. The day close cannot
compute expected card and expected cash separately without knowing which.

**Two-level close with a blind count.** Each waiter / till operator closes a
shift by declaring cash and card BEFORE seeing what was expected; a manager
then closes the trading day against the drawer and the card machine batch.
The trading day is opened and closed explicitly, never by the clock, so a
Saturday that runs past midnight is one day.

## Architecture — one stock engine, two owners

### `Venue` (new)

```
{ vendorId (unique, v1), name, currency: 'SZL'|'ZAR',
  status: 'active'|'suspended', activatedAt, activatedBy }
```

Created when a super-admin switches venue trading on. Money everywhere stays
integer minor units, as in the rest of cashless; the venue's `currency` is what
the dashboard and POS display.

### Event-or-venue ownership on shared models

`Merchant` (stall), `Product`, `ProductStock`, `StockMovement`, `StockCount`,
`StockTransfer`, `Table`, `Waiter`, `MerchantOperator` and `MerchantCharge` gain
an optional `venueId` beside `eventId`, which becomes optional. A schema-level
validator requires **exactly one** of the two: a document with both or neither
is rejected at save.

Every existing row already has `eventId`, so no data is backfilled.

### `TradingScope`

```ts
type TradingScope =
  | { kind: 'event'; eventId: string }
  | { kind: 'venue'; venueId: string };

scopeFilter(scope)  // → { eventId } | { venueId }   — for queries
scopeFields(scope)  // → the same, as ObjectIds        — for writes
```

**Take a scope:** the stock engine (`StockService.applyMovement`), stock-takes,
transfers, stock reports and the reconciliation PDF, low-stock alerts, the
non-paying table operations (open, list, add/remove items, void), stall and
catalogue admin, and staff auth.

**Stay event-only** (keep an `eventId` parameter, so a venue scope cannot reach
them by type): `Wallet`, `LedgerService`, `Cashier`, top-ups and withdrawals,
`MerchantService.charge` (tag charge) and `TableService.settle` (tag settle).

### Staff tokens and gates

A waiter or till-operator JWT carries `eventId` OR `venueId`; auth middleware
turns it into `req.scope`. The gate differs by kind:
- event: the event is published and cashless (unchanged);
- venue: `Venue.status === 'active'`.

### Index changes (migration script, run BEFORE deploy)

Two existing unique indexes would collide for venues, whose rows have no
`eventId` (indexed as `null`):
- `Product {eventId, barcode}` — the same barcode at two venues;
- `Table {eventId, label}` (partial, open) — "Table 7" at two venues.

Each is dropped and recreated with `eventId: {$exists: true}` in its partial
filter, and a `venueId` twin is added (barcode unique per venue; one open label
per venue). This runs as a script before the API deploy — NOT left to on-boot
`autoIndex`, because a same-name/different-options index blocks the build
(the `keshlessVendorId` incident).

## Phase 1 — The venue account

**Sign-up and login (website, prod branch `master`).**
- `BuyerAuthPanel` mode grows from `'user' | 'business'` to
  `'user' | 'business' | 'venue'`; the venue card reads "Bar, restaurant or
  lounge".
- Venue sign-up: business name, phone or email, password → OTP (verify-first)
  → the EXISTING organizer `POST /api/tickets/auth/register/request-otp` and
  `POST /api/tickets/auth/register` with `businessType: 'venue'`. Not the
  website's Business path (`/auth/business/register`), which creates SERVICES
  vendors.
- Venue login is the existing vendor login; the Venue card on the Log-in tab
  is wording only.
- `?as=venue` deep-links to the Venue form, as `?as=business` does.
- After sign-up a venue lands where organizers land: the social feed with the
  switch-to-dashboard bar.

**Admin switch-on (super-admin Organizers tab).**
- "Venue trading" action per vendor → creates the `Venue` (`name`, `currency`).
- Suspend / reactivate flips `status`.
- A vendor that already has a venue → **409**. Unknown vendor → **404**.

**Dashboard.**
- The vendor profile returns `venue: { id, name, currency, status } | null`.
- Active venue + permission → a **Venue** section in the sidebar.
- `businessType: 'venue'` without a venue → "Venue trading isn't on yet —
  Carrot switches it on after a quick check."
- Suspended → "Venue trading is suspended — contact Carrot."
- Events stay available.

**Permissions.** New `tickets:manage_venue` (stalls, staff, venue settings) in
the owner role, grantable to sub-users. Venue stock reuses
`tickets:manage_stock`.

## Phase 2 — Stalls, catalogue, stock and till staff

**One set of handlers, two entry points.** Two thin middlewares set
`req.scope`:
- `eventScope` — the existing checks (event exists, vendor owns it, cashless);
- `venueScope` — the vendor's `Venue` exists, is active, and the user holds the
  permission.

The existing stall / catalogue / stock / till-staff handlers read `req.scope`
instead of `req.params.eventId`, and are mounted twice:
- `/api/tickets/events/:eventId/stock/...` etc. — URLs unchanged;
- `/api/tickets/venue/stock/...`, `/venue/products`, `/venue/stalls`,
  `/venue/stalls/:id/operators` — no id in the URL; the venue comes from the
  logged-in vendor, so one venue cannot address another's.

**What a venue gets, reused as-is:** stalls; catalogue (barcodes, case/unit
packs, short + bottle products); receive; transfers between stalls (a store
room is a stall nobody sells from — no new concept); opening / interim /
closing stock-takes; the bulk stock-take import; low-stock alerts (already
addressed to the `vendorId`); stock board, dashboard and movements;
reconciliation and its PDF.

**What differs:**
- **Reconciliation window.** Events reconcile from event start. A venue trades
  indefinitely, so pairing "latest opening" with "latest closing" would match
  this morning's opening against last night's closing. Venue reconciliation
  takes an explicit date range, default today. Phase 4 replaces this with the
  trading day.
- **No commission.** Venue stalls stay at `commissionPercent: 0`; the dashboard
  hides the field.
- **Currency** is the venue's.

**Till staff (POS).** Till operators only in this phase. PIN login; the token
carries `venueId`; the app shows the venue name and the existing stall
stock-count page. A venue till token on the tag-charge endpoint gets a loud
**403 "tag payments aren't used at venues"**. Waiters and selling arrive in
Phase 3, so no login ships with nothing to do.

**Dashboard.** Venue › Stalls, Catalogue, Stock, Till staff — the existing
Event › Cashless components, given an API-base prop rather than copied.

## Phase 3 — Selling

### Waiters, orders and handover

Waiters are `Waiter` documents with `venueId`, PIN login. "A waiter works their
OWN tables" holds.

**Orders (rounds).** `POST /venue/tables/:id/orders`
`{ clientTxnId, items: [{ productId, merchantId, qty }] }`. In ONE transaction:
- push the lines, each carrying `orderId`;
- write the stock SALE movements (hard-block at zero — one short item rolls the
  whole round back);
- add one order row per stall:
  `{ _id, merchantId, lineIds, clientTxnId, status: 'sent'|'handed_out'|'collected', sentAt/By, handedOutAt/By, acceptedAt/By }`.

A retried round (same `clientTxnId`) replays the result. This replaces the
waiter app's one-`addItem`-per-line loop for venues, so a round reaches the bar
as one order.

**Handover.** The stall's till shows a queue of `sent` orders and taps *Hand
out*; the waiter taps *Accept*. Same two-stamp handshake as events, with
`advanceFulfilment` generalised to address an order row instead of a stall row.
Event tables keep `fulfilment` (pay-first); venue tables use `orders`. The
table's scope decides — no flag.

**Removing a line** is allowed only while its order is still `sent` (it never
left the counter); its stock goes back. After hand-out it was served and cannot
be removed.

**Walkouts** use the existing `voidTable` — "close an unpaid table WITHOUT
returning stock" — manager-only (dashboard), with a reason. A part-paid table
can be voided; its unpaid balance is reported as written off.

### Counter sales

`POST /venue/till/sales` `{ clientTxnId, items, payment }`. One transaction:
stock SALE movements (hard-block at zero), a `MerchantCharge` (the stall's
takings), and a `VenuePayment`. Paid in full at once; mixed tenders allowed, no
splitting. The till keeps its basket screen; the tag tap is replaced by the
payment sheet.

### Stall takings — `MerchantCharge`

`MerchantCharge` joins the event-or-venue scope. `walletId` and `bandUid` stay
required only for event charges; venue charges carry `fee: 0`. The existing
stall takings, the stock board (which derives "what left the shelf" from
charges) and per-operator takings then work for venues unchanged.

A venue table writes its per-stall charges when it is **paid in full** — keyed
`${closingClientTxnId}:${merchantId}`, attributed to the table's current
waiter — as event settle does. A walkout writes **none**, as an event void
writes none today.

### Payments — `VenuePayment` (new)

```
{ venueId, shiftId, tableId? | merchantChargeId?, clientTxnId,
  tenders: [{ method: 'cash'|'card', amount, tip, reference? }],
  applied,                      // Σ amount — what this takes off the bill
  tips,                         // Σ tip — never counted as sales
  lines?: [{ lineId, qty }],    // only when paying for specific items
  takenBy, takenByType: 'Waiter'|'MerchantOperator', staffName, at }
```

Unique `{venueId, clientTxnId}`: a POS retry returns the original payment.
`shiftId` is required from Phase 4 (see below); Phase 3 ships without it.

- **Mixed tenders** — R300 cash + R450 card in one payment.
- **Tip per tender** — see Decisions.
- **Card** — the venue's machine; optional slip `reference`.
- **Cash change** — the sheet takes cash handed over and shows change; only
  `amount + tip` counts toward the drawer.

**Splitting.** A table takes any number of payments. The sheet offers:
- *Guest's items* — pick lines and quantities ("3 of the 6 beers"), recorded as
  `paidQty` per line;
- *Split evenly* — outstanding ÷ guests still to pay, computed in the app in
  whole cents; the last guest pays the exact remaining outstanding, so the
  remainder cents never strand a table open;
- *Custom amount*.

**Rules, enforced in one guarded atomic update on the table:**
- `applied` ≤ outstanding — anything over is a tip or change, never an
  overpayment;
- a line cannot be paid beyond its `qty`;
- a line with any `paidQty` cannot be removed;
- items may still be added after a part-payment (the balance grows);
- two payments racing for the same balance: one wins, the other gets **409
  "the bill changed — check the balance"**.

**Closing.** The payment that brings `paidTotal` to `subtotal` flips the table
to `settled` in the SAME update, then writes the per-stall charges, exactly
once. A table with an unpaid balance closes only by walkout void.

Table additions (venue tables only): `orders[]`, `paidTotal`,
`items[].orderId`, `items[].paidQty`. Event tables leave them empty / unused.

## Phase 4 — Shifts, trading days and reports

### `TradingDay` (new)

```
{ venueId, status: 'open'|'closed', openedAt, openedBy, closedAt, closedBy,
  expected: { cash, card }, shiftDeclared: { cash, card },
  counted: { cash, cardBatches: [{ label, total }] },
  variance: {
    cash,          // counted.cash − expected.cash
    cashHandover,  // counted.cash − shiftDeclared.cash  (lost between shifts and the drawer)
    card,          // Σ counted.cardBatches − expected.card
  }, note }
```

One open day per venue (partial unique index). The day **opens itself** when
the first shift of the day opens, so staff are never blocked waiting for a
manager. A manager closes it.

### `Shift` (new)

```
{ venueId, tradingDayId, staffId, staffType: 'Waiter'|'MerchantOperator',
  staffName, openingFloat, status: 'open'|'closed', openedAt, closedAt,
  expected: { cash, card, cashTips, cardTips },
  declared: { cash, card }, variance: { cash, card }, note }
```

- One open shift per person.
- **Taking money requires an open shift.** `VenuePayment.shiftId` becomes
  required; without a shift → **409 "open your shift first"**.
- Expected cash = opening float + cash amounts + cash tips.
  Expected card = card amounts + card tips. Both ± adjustments.
- **Blind count.** At shift close the person enters cash counted and card slips
  total FIRST. Only after submission does the response carry expected and the
  variance. The server enforces this: no staff-token endpoint returns the
  expected figures of an OPEN shift. The manager (dashboard) can see running
  expected at any time.
- A waiter cannot close a shift with open tables; the refusal lists them. A
  manager can **reassign a venue table** to another waiter (dashboard), recording
  from-whom, by-whom and when.

### `ShiftAdjustment` (new)

```
{ shiftId, from: 'cash'|'card', to: 'cash'|'card', amount, reason, by, at }
```

Payments are immutable. A mis-keyed tender ("R200 was card, keyed as cash") is
corrected by an adjustment; expected totals are payments ± adjustments, so the
original and the correction both survive.

### Day close (manager, dashboard)

- Refused while any shift or table is open — with the list of what is blocking.
- The manager enters drawer cash and the card machine batch total(s), one row
  per machine.
- The day records three figures side by side: system expected, shift-declared,
  manager-counted — and the variance between each. Shift variances roll up
  beneath.
- Opening and closing stock-takes attach to the day; the stock reconciliation
  and its PDF default to **this trading day**.

### Reports (dashboard)

`tickets:view_revenue`; CSV needs `tickets:export_reports`.
- **Day summary:** sales by stall, product and waiter (from charges); money
  collected by cash / card (from payments); tips by waiter; walkouts (served,
  collected, unpaid); variances; open / close times.
- **Date range:** day-by-day totals, CSV export.

## Failure modes — fail loudly

| Situation | Answer |
|---|---|
| Doc with both / neither of `eventId`, `venueId` | rejected at save |
| Venue scope reaching an event-only service | compile error (type) |
| Venue till token on tag charge | 403 "tag payments aren't used at venues" |
| Venue suspended | staff logins and venue routes refused, with the reason |
| Round with an out-of-stock item | whole round rolled back, item named |
| Remove a line already handed out / partly paid | 409, nothing changed |
| Payment exceeds outstanding / line over-paid | 400, nothing written |
| Concurrent payments on one balance | one wins; other 409 "the bill changed" |
| Payment without an open shift (Phase 4) | 409 "open your shift first" |
| Shift close with open tables | 409 listing the tables |
| Day close with open shifts / tables | 409 listing them |
| Admin switches on a second venue for a vendor | 409 |

No path swaps in default data to look successful.

## Out of scope (v1)

- Refunds or reversal of a recorded payment (mis-keys are shift adjustments).
- Comps / price overrides after hand-out.
- In-system fees, subscriptions or invoicing — Carrot bills off-platform.
- More than one location per account in the UI.
- Carrot-processed card payments.
- Sharing stock between a venue and an event it hosts.
- Tags, wallets, top-ups at venues.
- A POS "manager" role — manager actions are in the dashboard.
- A printable end-of-day PDF (CSV and screen only; PDF can follow the stock
  reconciliation PDF pattern later).

## Build order

Four phases, each with its own implementation plan, each shippable alone:

1. **Venue account** — Venue tab, admin switch-on, dashboard Venue section.
2. **Stalls, catalogue, stock, till staff** — the scope refactor lands FIRST
   with the existing suites green and unchanged, before any venue route is
   mounted. Venues get day-to-day stock management at the end of this phase.
3. **Selling** — waiters, rounds and handover, counter sales, payments.
4. **Shifts, trading days, reports.**

## Testing

**Guard for live events:** the existing stock, stall, staff and table suites
pass UNCHANGED for the event path in every phase.

- **Phase 1:** admin switch-on / suspend / double-activate (409) / unknown
  vendor (404); register with `businessType: 'venue'`; profile carries
  `venue`; the website panel offers three modes and the Venue form posts
  `venue`; the dashboard Venue section appears only with an active venue AND
  the permission.
- **Phase 2:** both / neither scope rejected; a venue stall id on an event URL
  → 404 and vice versa; vendor A cannot reach venue B; the same barcode at two
  venues and an event; venue reconciliation respects its window; venue till
  token refused on tag charge; the index migration script is idempotent.
- **Phase 3:** a round is atomic and replays on retry; out-of-stock rolls the
  round back; handout → accept transitions guarded; remove after handout
  refused; concurrent last-balance payments → one 409; retry returns the same
  payment; line double-pay and overpay refused; close writes charges exactly
  once; walkout writes none; counter sale must equal its basket; tips never
  in sales totals.
- **Phase 4:** expected maths (float, tips by tender, adjustments); one open
  shift per person, one open day per venue; payment without a shift refused;
  blind count — no staff endpoint exposes an open shift's expected; shift close
  refused with open tables and unblocked by reassignment; day close refused
  with open shifts / tables; day auto-opens on first shift; variance figures;
  reconciliation window equals the trading day.

## Deploy notes

- API: trigger `carrot-tickets-api-main-deploy` on `main`. Phase 2's index
  migration script runs against prod BEFORE the deploy that depends on it.
- Wait for the new Cloud Run revision at 100% before pushing the website or
  dashboard (Pages builds faster than Cloud Build).
- Website deploys from `master`; dashboard from `main` (Cloudflare Pages).
- POS app changes (Phases 2–4) need a new build, made only on request.
