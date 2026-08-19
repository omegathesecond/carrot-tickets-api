# Tag management for organizers — design

**Date:** 2026-08-19
**Status:** awaiting review
**Surface:** api (`carrot-tickets-api`) + dashboard (`carrot-tickets-dashboard`)

## Problem

An organizer running a cashless event can see the money in aggregate (Cashless →
Money) and the stock behind it (Cashless → Stock), but nothing about the **tags**
themselves. Every question a desk actually gets asked mid-event is currently
unanswerable from the dashboard:

- "How much is still sitting on people's tags?"
- "This attendee lost their tag — kill it and give them a new one."
- "They say they topped up E200 and only spent E50. What does their tag show?"
- "The event is over and they want their E150 back."

The data to answer all of this already exists. `Wallet` is the authoritative
per-tag record (balance, cash-funded portion, status, the ticket it belongs to);
`BandBinding` is an append-only bind/unbind history; `LedgerEntry`,
`WalletTopup`, `MerchantCharge` and `WalletWithdrawal` carry every movement.
What is missing is a read surface and two write actions.

## Scope (decided with the client, 2026-08-19)

| Decision | Choice |
|---|---|
| Actions | See + lost-tag handling + **refunds** |
| Refund means | **Record an office cash refund** — not a gateway reversal |
| Tag pool | **Only tags in use**; no pre-registration of tag stock |
| Placement | Event → Cashless → **Tags** (5th sub-tab) |
| Vocabulary | "tag" in the UI, `band`/`bandUid`/`BandBinding` in code |

Explicitly **out of scope**: registering unissued tag stock to an event;
refund-to-source (card/MoMo reversal); anything on the POS handheld.

## Why "only tags in use" is coherent

A tag has no meaning to this system until it is bound to a ticket — the UID is
just a number on a plastic band. Everything the organizer wants to know is a
property of the **wallet**, not the plastic. The cost of the choice is that the
screen cannot answer "how many of our 5 000 tags are unaccounted for"; that
needs a `BandTag` pool model and a bulk-enrol flow, deferred deliberately.

## Data model

**No new collections.** Two additive changes to `WalletWithdrawal`:

1. `method` gains `'office_cash'` (currently `['cash']` only). A venue cash-out
   and an office refund are the same movement of money but not the same event in
   the organizer's world, and reconciliation must be able to tell them apart.
2. `recordedByType` gains `'Vendor'` (currently
   `Cashier | ResellerOperator | MerchantOperator | Platform`). An office refund
   is recorded by an organizer user, not by any operator type.

**One additive change to `FloatTag`:** add `OFFICE = 'office'` alongside
`KESHLESS` and `CASH_DESK`. The float credit for an office refund is not cash
leaving a desk at the venue — tagging it `CASH_DESK` would corrupt the venue
cash reconciliation that tag exists to serve.

## API

All under the existing organizer namespace, all behind
`loadOwnedCashlessEvent` (event exists + is cashless + belongs to this vendor).

| Endpoint | Permission | Returns |
|---|---|---|
| `GET /api/tickets/events/:eventId/tags/summary` | `VIEW_REVENUE` | the stats strip |
| `GET /api/tickets/events/:eventId/tags` | `VIEW_REVENUE` | paginated tag list |
| `GET /api/tickets/events/:eventId/tags/:walletId` | `VIEW_REVENUE` | one tag in full |
| `POST /api/tickets/events/:eventId/tags/:walletId/deactivate` | `MANAGE_ACCESS` | unbind a lost tag |
| `POST /api/tickets/events/:eventId/tags/:walletId/reissue` | `MANAGE_ACCESS` | bind a new UID to the same wallet |
| `POST /api/tickets/events/:eventId/tags/:walletId/refund` | `REFUND_TICKET` | record an office cash refund |

### Keyed on walletId, never on bandUid

`BandBinding` rows are never mutated except to stamp `unboundAt`, so **one UID
legitimately appears across several wallets** over an event's life (lost tag
reissued to someone else, band recycled between days). A UID-keyed detail route
would silently merge two attendees' histories. The wallet is the thing with
continuity; the UID is a pointer that changes.

### `GET .../tags/summary`

`tagsInUse`, `activeTags`, `deactivatedTags`, `balanceOutstanding`,
`cashFundedOutstanding`, `toppedUp`, `spent`, `cashedOut`, `refundedAtOffice`,
`averageBalance`. Aggregations over `Wallet` (by `eventId`, grouped by status)
and the movement collections. Where a figure already exists on
`OrganizerCashlessService.summary` (circulated / spent / withdrawn / left
behind), **reuse that service rather than recomputing** — two implementations of
"spent" that drift is a support nightmare.

### `GET .../tags`

Cursor pagination on `_id` desc with `limit + 1 → hasMore/nextCursor`, matching
the stock movements endpoint. Filters: `status` (active / deactivated /
unbound), `q` (tag UID prefix, or holder name/phone). Each row:
`walletId`, `bandUid`, `status`, `balance`, `cashFundedBalance`,
`holder { name, phone, ticketCode }`, `lastActivityAt`.

`lastActivityAt` comes from the newest `LedgerEntry` for that wallet, not from
`wallet.updatedAt` — `updatedAt` moves on any write, including an unbind, which
is not "activity" in the sense the organizer means.

### `GET .../tags/:walletId`

Wallet + holder + **binding history** (`BandBinding` rows, newest first, each
showing when it was bound, by whom (`boundBy`), and when/why it was released
(`unboundAt` / `unboundReason` — both already persisted)) + **merged transaction history**: top-ups (`WalletTopup`), spends
(`MerchantCharge`, with the stall name), cash-outs and office refunds
(`WalletWithdrawal`), sorted by time, each with the resulting balance where the
source records one. Paginated the same way as the list.

### `POST .../tags/:walletId/refund`

Mirrors `WalletService.withdrawCash` exactly — the same atomic CAS
(`status: 'active'`, `balance >= amount`), the same balanced posting
(`WALLET +amount`, `FLOAT -amount`), the same `{walletId, clientTxnId}`
idempotency — differing only in `method: 'office_cash'`,
`recordedByType: 'Vendor'`, `recordedBy: <ticketsUser id>`, and
`tag: FloatTag.OFFICE` on the float leg.

**It must not be a second implementation.** `withdrawCash` will be generalised
to take `{ method, recordedByType, recordedBy, floatTag }` with the current
cash-desk values as defaults, so both callers run the same money code. A second
copy of a balanced-posting routine is exactly how ledgers drift.

Declines surface as they do at the desk: `WalletDeclinedError` →
`insufficient_balance` / `wallet_not_active` / `wallet_not_found`, mapped to
402/409/404 rather than a generic 400, so the UI can say something true.

### Deactivate / reissue

Thin wrappers over `WalletService.unbindBand(walletId, reason)` and the existing
reissue path. The balance stays on the wallet throughout — that is precisely
what the server-authoritative-wallet decision was for. Reissue requires the new
UID to be unbound for this event (the `{eventId, bandUid}` partial-unique index
enforces it; the service must surface the collision as a clean 409, not a 500).

## Dashboard

New `Tags` sub-tab inside `EventCashlessTab`, gated on `VIEW_REVENUE` like the
other report tabs, built from the same panel pattern as Stalls and Catalogue
(`src/components/cashless/EventTagsPanel.tsx`, `eventId` as a prop).

1. **Stats strip** — reuses the existing `StatCard`.
2. **Tag table** — search box, status filter, load-more. Row click opens detail.
3. **Detail sheet** — holder, balance split, binding history timeline,
   transaction list. Actions live here, each behind its own confirm:
   - *Deactivate* asks for a reason (free text, stored on the binding).
   - *Reissue* asks for the new tag's UID.
   - *Refund* shows the balance, defaults the amount to it, allows less, and
     states in words that this records cash handed over at the office — it does
     not send money anywhere.
4. Buttons are permission-gated client-side for tidiness; the server is the
   guard.

## Money-handling invariants to preserve

- `cashFundedBalance <= balance` is maintained by an atomic `$max` pipeline, not
  a model hook (hooks do not fire on `$inc`). The screen reads both as stored
  and never derives one from the other.
- Cash-funded balances are never auto-swept; every office refund is an explicit,
  recorded, human action.
- Every write is idempotent on `{walletId, clientTxnId}`; the client generates
  the id so a double-submit cannot double-refund.
- No silent fallbacks: a declined refund surfaces the decline. The screen never
  shows a success state it did not get from the server.

## Testing

- **Service:** refund posts a balanced pair and moves the balance; refund on an
  inactive wallet declines; refund above balance declines; idempotent retry
  returns the original withdrawal and does not double-post; the generalised
  `withdrawCash` still behaves identically for the cashier path (regression).
- **Reporting:** summary figures agree with the ledger on a seeded event;
  `lastActivityAt` ignores a pure unbind; the list pages without dropping or
  repeating a row across a cursor boundary.
- **Detail:** a UID bound → unbound → rebound to a different wallet yields two
  separate histories, neither containing the other's transactions.
- **Route:** each endpoint 403s without its permission, 404s another vendor's
  event, and 400s a malformed cursor/limit.
- **Dashboard:** the panel renders each status; actions are hidden without
  permission; a declined refund surfaces the server's message.

## Slices

1. **Read API** — summary, list, detail (+ tests). No writes, no UI.
2. **Dashboard read UI** — Tags sub-tab, stats, table, detail sheet.
3. **Lost-tag actions** — deactivate + reissue, api then UI.
4. **Office refund** — generalise `withdrawCash`, add the endpoint, then the UI
   with its confirm.

Slices 1–2 are independently shippable and answer most of the questions above;
3–4 add the write actions. Each slice is a commit with its tests.

## Open questions

None blocking. Deferred by choice: tag-stock pre-registration, refund-to-source,
and any POS tag-desk screen (the POS still has no band UI at all, so tags are
issued from the gate app's bind flow only).
