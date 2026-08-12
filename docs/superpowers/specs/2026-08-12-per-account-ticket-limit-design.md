# Per-account ticket limit ("one ticket per person")

**Date:** 2026-08-12
**Repo:** carrot-tickets-api
**Branch:** `feat/per-account-ticket-limit` (worktree off `origin/main`)
**Status:** Design — approved decisions captured, ready for implementation plan

## Problem

An organizer wants to run an event — **The Legends Cup 2027** — where **each person may hold
at most one ticket for the event**. Today the only quantity guard is
`MAX_TICKETS_PER_ORDER = 10`, which caps a *single order*. It looks at nothing the buyer has
bought before, so ten separate one-ticket orders defeat it entirely. There is no notion of a
per-buyer, cross-order cap anywhere in the codebase.

## Goal

Add a **reusable, per-event cap on how many active tickets a single buyer identity may hold for
that event**, enforced across every sale channel, keyed on the buyer's account with their phone
as a safety net. Activate it (value `1`) on The Legends Cup 2027 only, via a manual script — **no
dashboard UI**.

## Non-goals

- **No organizer-facing UI.** No dashboard control, no POS control. The field is set manually
  (a one-off script / direct update) when the owner asks. Dashboard work is explicitly out.
- **No per-ticket-type limit.** The cap is event-wide (one ticket for the whole event, summed
  across all its ticket types), matching "one ticket per person only".
- **No backward-incompatible changes.** The field is optional and absent = unlimited, so every
  existing event behaves exactly as before.
- **No new payment/identity concepts.** Reuse the existing buyer-identity precedence.

## Decisions (locked with the owner)

| Decision | Choice |
|----------|--------|
| Identity of "a person" | **Account-first, phone safety net**: match on `buyerId` OR the buyer's normalized `customerPhone`. Mirrors the app's existing `buyerId → userPhone` precedence (`resolveBuyerFromRequest`). |
| Channels covered | **All channels** — online (MoMo, card, DeltaPay, free, Keshless card) and in-venue POS/cash. All funnel through one gate. |
| Configuration surface | **Reusable per-event field, no UI.** Owner activates it per event via a script when wanted. |
| Cross-type scope | **Event-wide.** Count all of the buyer's active tickets for the event, across ticket types. |

## Key facts the design relies on (verified against `origin/main`)

- **Single choke point.** Every sale path calls
  `EventService.checkTicketAvailability(eventId, ticketTypeId, quantity, method?)`:
  - `TicketService.sellTickets` (ticket.service.ts:270) — the **synchronous mint** for cash/POS,
    free claims (`claimFreeTicket → sellTickets`), and Keshless-card purchases. Authoritative:
    the ticket is minted in this same call.
  - `TicketService.initiateMomoPurchase` (1140), `initiateCardPurchase` (1295),
    `initiateDeltapayPurchase` (1439) — **pre-flight** checks before an async payment. The actual
    mint happens later in the matching `finalize*Sale` method.
  - `TicketService.issueWristbandBatch` (714) — wristband channel.
- **Online is always authenticated.** All `/api/public/purchase*` routes are `authenticateBuyer`.
  Every online ticket is tied to an OTP-verified identity (`buyerId` if registered, else a
  verified `userPhone`). **There is no anonymous-online bypass.**
- **Canonical identity resolver** already exists: `resolveBuyerFromRequest(req)` →
  `Buyer.findById(buyerId)` else `Buyer.findOne({ phone: normalizePhone(userPhone) })`
  (`src/utils/buyerRequest.util.ts`).
- **Tickets** carry `buyerId`, `customerPhone`, `customerEmail`, `status`
  (`TicketStatus = available | sold | checked_in | refunded | cancelled`). **Active** = status
  NOT in `{refunded, cancelled}`.
- **`normalizePhone`** (`src/utils/phone.util.ts`) is the canonical phone normalizer already used
  at buy time and for "My Tickets" matching.

## Design

### 1. Data model — one optional field

Add to `IEvent` (`src/interfaces/event.interface.ts`) and `eventSchema`
(`src/models/event.model.ts`):

```ts
/**
 * Max ACTIVE tickets a single buyer identity may hold for this event, summed
 * across all ticket types. Undefined/absent = unlimited (default). Set to 1 for
 * strict "one ticket per person". Enforced in checkTicketAvailability against
 * buyerId OR normalized customerPhone. No dashboard UI — set via script.
 */
maxTicketsPerAccount?: number; // integer >= 1 when set
```

Absent by default → zero behavior change for every existing event.

### 2. Enforcement — extend the one shared gate

Add an optional `buyer` identity argument to
`EventService.checkTicketAvailability(eventId, ticketTypeId, quantity, method?, buyer?)`:

```ts
buyer?: { buyerId?: string | Types.ObjectId | null; phone?: string | null }
```

Inside the gate, after the existing sold-out / stock checks, when
`event.maxTicketsPerAccount` is a positive number **and** a `buyer` identity is supplied:

1. Build an identity `$or`:
   - `{ buyerId }` when present.
   - `{ customerPhone: normalizePhone(buyer.phone) }` when a phone is present.
   - If neither yields a key (e.g. POS sale with no phone and no account) → **skip** the
     per-account check (nothing to key on; availability still enforced normally).
2. Count the buyer's active tickets for the event:
   ```ts
   Ticket.countDocuments({
     eventId,
     status: { $nin: [TicketStatus.REFUNDED, TicketStatus.CANCELLED] },
     $or: identityClauses,
   })
   ```
3. If `existingActive + quantity > event.maxTicketsPerAccount` → return
   `{ available: false, message: <limit message> }`.

**Message:** for a limit of 1, "You already have your ticket for this event — it's limited to one
per person." For a general limit N, "This event is limited to N ticket(s) per person; you already
have <existingActive>." (Exact copy finalized in the plan.)

Comparison is `existingActive + quantity > limit`, so a single over-quantity order (`quantity=3`,
limit 1) **and** a repeat purchase (already have 1, buy 1 more) are both rejected by the one
expression.

### 3. Threading the buyer identity into the gate

Each caller passes the identity it already has:

- **`sellTickets`** — pass `{ buyerId: params.buyerId, phone: params.customerPhone }` (whatever
  the sale carries). Covers POS/cash + free + Keshless card at mint time (authoritative).
- **`initiateMomoPurchase` / `initiateCardPurchase` / `initiateDeltapayPurchase`** — pass the
  authenticated buyer's identity (`buyerId` / verified phone) for a pre-flight rejection, so a
  buyer who already has a ticket is stopped *before* being sent to pay.
- **`issueWristbandBatch`** — pass identity if present; wristband channel is staff-issued and
  usually has none, so it typically skips (acceptable).

### 4. Race safety on the async paths

The async initiators check pre-payment; the mint happens later in `finalizeMomoSale` /
`finalizeCardSale` / `finalizeDeltapaySale`. To stop two concurrent checkouts both minting, the
per-account check is **re-run at mint time inside each `finalize*Sale`** (they carry the pending
sale's `buyerId` + phone). Since a `finalize*` that fails the limit must not silently drop a
*paid* order, the plan will define the failure handling explicitly (e.g. refund/void path or a
flagged sale for manual reconciliation) rather than swallowing it — consistent with the
"fail loudly, no silent fallback" rule.

There is **no clean unique-index guarantee**: a partial unique index on `{eventId, buyerId}`
cannot be made conditional on the event's own `maxTicketsPerAccount` flag, and an unconditional
one would break every multi-ticket event. So enforcement is application-level. Residual race: a
buyer double-submitting two checkouts within the same instant could, worst case, end with 2
tickets. This is a low-stakes business rule (not money integrity); the double check
(initiate + finalize) closes the common case. This limitation is stated, not hidden.

### 5. Activation script (manual, no UI)

A one-off script `src/scripts/setPerAccountLimit.ts` (or a documented `mongosh` update) that sets
`maxTicketsPerAccount = 1` on The Legends Cup 2027 by event id/slug. Run only when the owner says
go. Idempotent; logs before/after.

## Failure modes & edge cases

- **Refund then rebuy.** A refunded/cancelled ticket is excluded from the count (`$nin`), so a
  buyer whose ticket was refunded may buy again. Correct.
- **POS sale, no phone, no account.** No identity key → per-account check skipped; the sale
  proceeds (availability still enforced). Documented as an inherent gap of an account-based rule.
- **Reseller allocation tiers.** Sold via DeltaPay-exclusive allocation with no buyer account →
  no identity → skipped. Out of scope by nature.
- **Buyer bought once phone-only, later as a registered account with the same phone.** The `$or`
  on `customerPhone` still catches it — that is the point of the phone safety net.
- **Quantity vs limit interaction.** `MAX_TICKETS_PER_ORDER` (10) is unchanged and independent;
  the per-account cap is the tighter bound when set.

## Files touched

- `src/interfaces/event.interface.ts` — add `maxTicketsPerAccount?`.
- `src/models/event.model.ts` — add schema field (`min: 1`, no default).
- `src/services/event.service.ts` — extend `checkTicketAvailability` with `buyer?` + the count.
- `src/services/ticket.service.ts` — pass identity at the 4 relevant call sites; re-check inside
  the 3 `finalize*Sale` mint paths.
- `src/utils/phone.util.ts` — reuse `normalizePhone` (no change).
- `src/scripts/setPerAccountLimit.ts` — activation script (new).
- Tests — see below.

**Not touched:** dashboard, POS app, landing/consumer UI, reseller allocation flow.

## Testing

- **Unit (gate):** `checkTicketAvailability` returns unavailable when `existingActive + qty >
  limit`, available when `<=`, and **skips** entirely when `maxTicketsPerAccount` is unset or no
  identity is supplied. Matches on `buyerId` alone, on phone alone, and on either via `$or`.
  Refunded/cancelled tickets don't count.
- **Integration (channels):** second online purchase (each of MoMo/card/DeltaPay/free/Keshless)
  by the same buyer for a limit-1 event is rejected; a first purchase succeeds; a different buyer
  succeeds; a refunded-then-rebuy succeeds.
- **Regression:** events with no `maxTicketsPerAccount` are wholly unaffected (existing suites
  green).

## Rollout

1. Merge behind the absent-by-default field (no active event uses it) → deploy to prod normally
   (`gcloud run deploy carrot-tickets-api --source .` from this worktree, per repo convention).
2. When the owner says go, run the activation script to set `maxTicketsPerAccount = 1` on
   The Legends Cup 2027.
