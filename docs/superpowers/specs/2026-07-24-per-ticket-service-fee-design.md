# Per-ticket service fee + hard max-10 per order

**Date:** 2026-07-24
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/per-ticket-service-fee` (worktrees: `api-fee-wt` off `main`, `landing-fee-wt` off `feat/frontend-cutover`)

## Problem

Today the buyer-paid service fee is a **flat amount per payment**, regardless of how
many tickets are in the order. A buyer paying by MoMo is charged E5 whether they buy
1 ticket or 8. We want the fee to be **per ticket**: 1 ticket = E5, 2 tickets = E10,
and so on — the configured per-method fee multiplied by the quantity.

Separately, the buyer must not be able to buy an unbounded number of tickets in one
order. The backend already caps online orders at 10, but the web stepper lets a buyer
choose up to full availability and then eats a 400 at checkout. We want a real,
consistent **max of 10 tickets per order** enforced in both the UI and the backend.

## Decisions (locked)

1. **Fee model:** each method's existing configured fee becomes *per ticket*
   (MoMo E5 → E5 × qty, Card E10 → E10 × qty, Keshless wallet as configured × qty).
   The per-method config values are unchanged — only their interpretation (flat →
   per-ticket) and the math change.
2. **Max per order:** 10 tickets, enforced in **both** the web UI stepper and the
   backend validators. This is a *per-order* cap ("at once") — a buyer can still place
   a second order; there is no cumulative per-event limit. (YAGNI: no cross-order
   tracking.)
3. **Workspace:** isolated git worktrees, one per repo, on branch
   `feat/per-ticket-service-fee`.

## Scope: what is (and isn't) affected

Service fees apply to **online buyer checkout only**. POS and reseller sales stay at
face value and are untouched by the fee change. The three online payment methods that
carry a service fee are: Keshless wallet, MTN MoMo, Peach card.

**In scope**
- Fee math becomes per-ticket (backend helper + its frontend mirror).
- Max-10 cap made real in the web stepper; backend `10` centralised as a named constant.

**Out of scope (deliberate)**
- Reseller POS cash cap of `max(20)` (`reseller.controller.ts`) — in-person channel,
  no service fee, a different product concern. Not touched. (Flag if alignment wanted.)
- The `/public/events/:id/payment-methods` service-fee API response shape — it stays a
  per-method map; the frontend multiplies by quantity locally.
- Payment-config seed values / admin settings — the per-method amounts don't change.

## Design

### Part 1 — Per-ticket fee

The fee math has a single backend source of truth (`serviceFee.util.ts`) with one
frontend mirror (`PurchaseModal.tsx`). The change lives almost entirely in those two
places.

**Backend — `api/src/utils/serviceFee.util.ts`**
- `serviceFeeFor(method, cfg)` is unchanged: it returns the configured per-method
  amount. Its meaning shifts from "flat per payment" to "per ticket"; doc comment
  updated accordingly.
- `computeServiceFee` gains a `quantity` parameter and multiplies:
  ```ts
  computeServiceFee(subtotal: number, quantity: number, method: PaymentMethod, cfg: ServiceFeeConfig): ServiceFeeBreakdown
  // serviceFeeAmount = round2(serviceFeeFor(method, cfg) * quantity)
  // amountCharged    = round2(subtotal + serviceFeeAmount)
  ```
- The `ServiceFeeConfig` / `ServiceFeeBreakdown` interfaces are unchanged. Doc comments
  change "FLAT" → "per ticket".

**Backend — call sites (all already have `quantity` in scope), `api/src/services/ticket.service.ts`**
- Keshless wallet — `purchaseForCustomer` (~L790): pass `quantity`.
- MTN MoMo — `initiateMomoPurchase` (~L961): pass `p.quantity`.
- Peach card — (~L1099): pass `p.quantity`.

Downstream math is already correct once the helper multiplies:
- `sellTickets` recomputes `amountCharged = round2(totalAmount + serviceFeeAmount)`
  from the passed `serviceFeeAmount` (~L253-254), so the wallet is debited
  `(price + fee) × qty`.
- MoMo/card store the returned `amountCharged` on the PENDING sale and charge the
  gateway that amount; the webhook/return finalizers compare against the stored
  `sale.amountCharged` (`expectedAmount = sale.amountCharged ?? sale.totalAmount`),
  so reconciliation stays consistent.
- `totalAmount` stays face value everywhere; only `serviceFeeAmount` / `amountCharged`
  scale with quantity. The invariant `amountCharged === totalAmount + serviceFeeAmount`
  continues to hold.

**Frontend mirror — `landing/src/components/PurchaseModal.tsx` (~L75)**
```ts
const serviceFee = method ? round2((serviceFees[method] ?? 0) * quantity) : 0;
const total = round2(subtotal + serviceFee);
```
The breakdown row already renders `serviceFee`, so it will read E5.00 for qty 1,
E10.00 for qty 2, etc. The displayed total continues to equal the amount charged.

### Part 2 — Max 10 tickets per order

**Backend — centralise the cap.** Introduce `MAX_TICKETS_PER_ORDER = 10` (exported
from `serviceFee.util.ts` or a small shared constants module) and reference it in the
four online buyer validators instead of the magic `10`:
- `api/src/controllers/public.controller.ts` — 3 sites (keshless / momo / card schemas).
- `api/src/controllers/tickets.controller.ts` — 1 site (in-app `purchaseAsUser`).

Behaviour is unchanged (still 10); this is a DRY cleanup so the number has one home.

**Frontend — make the stepper cap real.** `landing/src/pages/EventPage.tsx`:
- Add a local `const MAX_TICKETS_PER_ORDER = 10;` (same mirror pattern as the fee — the
  frontend can't import backend code).
- The `+` handler (~L95-96) bounds new quantity at
  `Math.min(MAX_TICKETS_PER_ORDER, availableQuantity)`.
- The `+` button `disabled` (~L389) uses the same bound so a buyer can never step past
  10 even when availability is higher.

## Edge cases

- **0-fee method / cash:** `serviceFeeFor` returns 0 → `0 × qty = 0`. No change; POS/
  reseller cash sales still pay face.
- **Availability < 10:** the stepper is bounded by `min(10, availableQuantity)`, so low
  stock still caps correctly.
- **PIN threshold (wallet):** keys off the **face** subtotal (`totalAmount`), unchanged;
  the per-ticket fee does not shift the E50 PIN rule.
- **Rounding:** all fee/total math routes through `round2`; per-ticket multiplication
  happens before rounding the fee, then the total is rounded once.
- **Pre-existing sales with no `amountCharged`:** finalizers already fall back to
  `totalAmount`; untouched.

## Testing

- **Unit — `serviceFee.util`:** qty 1/2/3 for each method (wallet/momo/card) asserts
  `serviceFeeAmount = configFee × qty` and `amountCharged = subtotal + fee × qty`;
  0-fee method → 0; a fractional-fee rounding case.
- **Frontend — stepper cap:** with `availableQuantity` > 10, stepping up stops at 10 and
  the `+` button is disabled at 10.
- **Frontend — fee mirror (optional, if a PurchaseModal test harness exists):** fee row
  reflects `configFee × quantity`.

## Rejected alternatives

- **Multiply `× qty` at each call site** instead of inside the helper — rejected: it
  duplicates the multiplication in 3 backend places and risks drifting from the single
  frontend mirror. Keeping it in `computeServiceFee` preserves the "one source of truth
  for fee math" property the file was built around.
- **Cumulative per-event purchase limit** — rejected as YAGNI; the ask was "at once"
  (per order). Would require tracking prior purchases per buyer/event.
