# Stall-scoped products, hardware scanning, and four desk fixes

**Date:** 2026-09-05
**Status:** Design — approved in chat, pending spec review
**Surfaces:** `carrot-tickets-api`, `carrot-tickets-dashboard`, `carrot-tickets-pos-app`

Six changes shipping as one release. Two are structural (stall-scoped
products, hardware scanning); four are small and independent, and are
specified here only because they ride in the same release.

## Problems

### A stall sees every other stall's products

`MerchantController.stock` loads `Product.find({ eventId, active: true })` —
*every* product at the event — then left-joins this stall's `ProductStock`
rows for quantities. A product the stall has never carried comes back with
`onHand: 0` rather than not at all, so the Shisanyama handheld shows the bar's
spirits and the bar shows quarter chickens. Both are `sold_out` tiles the
operator must scroll past on every round.

### Scanning goes through the camera

Both scan surfaces drive `mobile_scanner`: the gate ticket scan
(`scan_page.dart`) and the product barcode sheet (`scan_barcode_sheet.dart`).
The handhelds have a hardware imager on a trigger button that the app ignores
entirely. Operators aim a camera and wait where a trigger press would be
instant.

### Four smaller gaps

- The dashboard's cashless tab calls the organizer's transaction report
  **Money**, which names the subject rather than the content.
- The cashier desk can top up and cash out, but cannot answer "what's my
  balance?" without moving money — even though the whole balance-lookup path
  already exists and is wired into the gate app.
- The cashier's History shows amount, status and time, with nothing
  identifying *which* band a top-up belongs to.
- A cart line can be stepped down one unit at a time but not removed, so
  clearing a mis-scanned case of 24 takes 24 taps.

## Non-goals

- **A backfill for existing products.** Explicitly declined: unallocated
  products stay hidden. See Rollout for what this costs.
- **Removing the camera.** Hardware scanning is added beside it. A device
  whose trigger emits nothing must keep working exactly as it does today.
- **Changing what a `Merchant` is.** Stalls are already the organizer's own
  in-venue bars; this spec scopes products to them and adds no new entity.
- **Barcode scanning on the cashier desk.** Bands are read by NFC there; the
  imager has nothing to scan.

## Design

### 1. Allocation is a `ProductStock` row

A stall carries a product **iff** a `ProductStock` row exists for
`(merchantId, productId)`. No new model, no new field.

This is already the system's own semantics rather than a convention invented
here. `StockService.adjust` upserts on a positive adjustment and refuses to
create a row on a decrement (`upsert: !decrement`), so receiving stock into a
stall already allocates the product to it, and selling a product a stall does
not carry already fails on the missing row. The catalogue feed is the only
place that disagreed.

**`MerchantController.stock`** inverts its query: load this merchant's
`ProductStock` rows first, then fetch only those products.

```ts
const rows = await ProductStock.find({ merchantId }).lean();
const byProduct = new Map(rows.map((r) => [String(r.productId), r]));
const products = await Product.find({
  eventId, active: true, _id: { $in: rows.map((r) => r.productId) },
}).sort({ name: 1 }).lean();
```

The response shape does not change, so the POS needs no parsing change for
this part. A stall with no allocations gets `{ stock: [] }` and the existing
empty state renders.

**Explicit allocation** gets its own endpoint rather than overloading the
threshold or receive routes, because "this stall carries this" and "this stall
received twelve" are different statements and only one of them is a stock
movement:

```
PUT /api/tickets/events/:eventId/stock/allocations
    { productId, merchantIds: string[] }   → { allocated: string[] }
```

It creates a zero-quantity row for each listed stall and removes rows for
delisted stalls. Ownership is enforced exactly as the sibling stock routes do
(`loadOwnedEvent`, plus the existing check that each merchant belongs to this
event).

**Delisting refuses to destroy stock.** A stall holding `onHand > 0` cannot be
removed from a product; the endpoint answers 400 naming the stall and its
quantity. Writing off or transferring that stock first is the honest path, and
it keeps the allocation endpoint from becoming a way to silently discard
inventory that the movement ledger would still claim exists.

### 2. Allocating from the dashboard

The catalogue's Add/Edit product dialog gains a **"Sold at"** multi-select over
this event's stalls, sitting directly beneath Category. On create, the chosen
stalls are allocated after the product is created (the product must exist
before it can be allocated). On edit, it reflects current allocations and
applies the difference.

Because a product allocated to nobody is invisible to every POS, the catalogue
list marks those rows **"Not on any stall"** in the same warning treatment the
sold-out badge uses. This is the only thing standing between the strict filter
and a silently empty handheld, so it is not optional.

Two conveniences that exist because of the deploy choice in Rollout:

- **Stalls must exist first.** When the event has no stalls, the dialog
  replaces the multi-select with a line pointing at the Stalls tab. A product
  can still be saved — it is simply not on any POS yet, and is flagged as such.
- **Allocate to all stalls** is a one-click action on the catalogue list, so
  restoring today's behaviour for the whole catalogue after deploy is a few
  clicks rather than a per-product pass.

### 3. Hardware scanning

The handheld's imager is a keyboard wedge: pressing the trigger with a notepad
open types the barcode into it. What is *not* known is whether it emits
individual key events (true HID) or commits the whole string at once (an IME),
and those need different capture code.

A single `HardwareScanField` widget covers both. It mounts a zero-size,
always-focused `TextField` whose on-screen keyboard is suppressed, watches its
value, and fires `onScan(code)` when a submit arrives or the value stops
changing for 120 ms. A text field sees IME commits *and* key events, so the
ambiguity does not have to be resolved before building. The idle timeout is
what makes it work for a wedge configured without a trailing Enter.

Both surfaces wrap their existing decode handler, so a hardware scan and a
camera decode travel the same path:

- **Gate** (`scan_page.dart`): a trigger press checks the ticket in without
  opening the camera. The camera stays behind its existing button.
- **Stall** (`charge_page.dart`): the listener lives on the charge page itself,
  not inside the barcode sheet, so a trigger press adds the product to the cart
  with no sheet to open first. This is the seamless part of the request; the
  sheet remains for devices with no imager.

**Failure is visible.** A scanned code matching no product shows the same
"no product with that barcode" message the camera path shows. A scan arriving
while a charge is in flight is ignored rather than queued, and says so.

### 4. Full tag ID in both histories

`CashierService.listTransactions` builds its rows from `WalletTopup` and
`WalletWithdrawal`, which carry `walletId` and no band identity. It gains a
single batched lookup of the wallets it just loaded, and maps
`walletId → bandUid` onto each row.

`bandUid` is **nullable on `Wallet`** — a wallet may be bound to a ticket
instead of a band — so `CashierTxn.bandUid` is nullable end to end, and a row
without one renders `—`. No placeholder, no fabricated identifier.

The POS shows the full value in both apps: the cashier history gains the field
it never had, and `merchant_transactions_page.dart` drops its `••ABCDEF`
truncation.

### 5. Two one-liners

- **`EventCashlessTab.tsx:185`**: the trigger's label becomes **Transactions**.
  `value="money"` is left alone — it is the `?sub=` URL key, and renaming it
  would break every existing deep link for a cosmetic gain.
- **`basket_panel.dart`**: each row gains a trailing X. `Basket.remove` already
  exists and `charge_page.dart:474` already passes `onRemove`; only the control
  was missing.

### 6. Check balance on the cashier desk

`BandOpsSheet(mode: BandOpsMode.balance)` already renders a band's balance and
recent activity against `GET /api/cashier/balance`, and is already reachable
from the gate app. The cashier desk gains a **Check balance** action that opens
the same sheet. Nothing new is built, and nothing server-side changes.

## Error handling

| Case | Result |
|---|---|
| Stall has no allocated products | `{ stock: [] }`; existing empty state |
| Delist a stall holding stock | 400 naming the stall and its quantity; no row removed |
| Allocate a product to a stall from another event | 400, as the sibling stock routes already answer |
| Hardware scan matches no product | Same inline message as a camera decode |
| Hardware scan during an in-flight charge | Ignored, with a message; never queued |
| Trigger emits nothing (no imager) | Camera path unchanged; nothing degrades |
| Wallet has no band (ticket-bound) | History renders `—` |
| Balance lookup finds no wallet | Existing 404 surfaces in the sheet |

No silent fallbacks: an unmatched scan, a refused delist, and a bandless wallet
each say what happened rather than showing a plausible substitute.

## Testing

**API (jest + supertest)**
- `/merchant/stock` returns only products with a row for that merchant, and two
  stalls at one event see disjoint lists
- a stall with no rows gets an empty list, not the full catalogue
- allocation creates zero-quantity rows and is idempotent
- delisting a stall holding stock is refused with its quantity named
- cross-event merchant or product is refused
- `listTransactions` carries `bandUid`, and null for a ticket-bound wallet

**Dashboard (vitest + Testing Library)**
- the dialog lists this event's stalls and applies an allocation difference
- a product allocated to nobody is flagged in the list
- no stalls → the pointer to the Stalls tab, and the product still saves
- the cashless tab's trigger reads Transactions and `?sub=money` still selects it

**POS (flutter test)**
- `HardwareScanField` fires once for a character-by-character code, once for a
  single-commit code, and on idle timeout with no trailing Enter
- a scan matching no product surfaces the message and leaves the cart alone
- removing a line leaves the others and their quantities intact
- a history row with a null band renders `—`

The imager itself is not testable off-device: what is asserted is the widget's
behaviour given each input shape. One confirmation pass on a handheld is
required before this is called done, and is called out in Rollout rather than
assumed.

## Rollout

**The filter and its allocations ship together, and the gap is real.** With no
backfill, the moment the API deploys every stall's POS is empty until products
are allocated. This was chosen deliberately over a backfill; the mitigations
are the "Allocate to all stalls" action and the "Not on any stall" flag, which
between them make the restore a few clicks and make an un-restored product
obvious in the dashboard.

**Do not deploy during a live event.** In the gap, a stall can sell nothing —
the POS renders an empty catalogue and the charge endpoint refuses items it has
no row for. Deploy between events, allocate, then confirm one stall's handheld
shows its own products and nothing else.

**Nothing to migrate.** No model changes, no new fields, no index changes. The
allocation endpoint writes rows that `StockService.adjust` has always been able
to create. Existing `ProductStock` rows already mean exactly what this spec
says they mean, so any stall that has ever received stock is already correctly
allocated for the products it received — the gap is only products that were
never received anywhere.

**One device check gates release:** press the trigger on a handheld against a
real barcode, on both the gate screen and the charge screen. Everything else is
covered by tests; this is not, and shipping it unverified would repeat a
mistake this project has already made once with camera code that seven passing
tests could not catch.
