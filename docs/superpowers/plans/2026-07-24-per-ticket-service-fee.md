# Per-ticket Service Fee + Max-10-per-order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the buyer service fee scale per-ticket (configured per-method fee × quantity) and enforce a hard cap of 10 tickets per order in both the web UI and the backend.

**Architecture:** Backend fee math has one source of truth — `serviceFee.util.ts` — so `computeServiceFee` gains a `quantity` param and multiplies; three online call sites pass their existing `quantity`. The web frontend mirrors this in a new pure-helper module `src/lib/pricing.ts` (`serviceFeeForOrder`, `clampTicketQuantity`, `MAX_TICKETS_PER_ORDER`), which PurchaseModal and EventPage consume. The 10-cap already lives in backend validators as a magic `10`; it gets centralised to a named constant.

**Tech Stack:** Node/TypeScript + Express + Joi (api, tests via jest), React + Vite + Vitest (landing).

## Global Constraints

- Service fees apply to **online buyer checkout only** — POS/reseller sales stay at face value. Do not touch reseller/POS fee paths.
- `totalAmount` always stays **face value** (`price × quantity`). Only `serviceFeeAmount` and `amountCharged` scale with quantity. Invariant: `amountCharged === round2(totalAmount + serviceFeeAmount)`.
- Per-method fee config values are **unchanged** (defaults: keshless 0, momo 5, card 10). Only their interpretation (flat → per-ticket) and the math change.
- Max tickets per order = **10**, enforced in UI **and** backend. Per-order cap (no cumulative per-event tracking).
- Reseller POS cap `max(20)` in `reseller.controller.ts` is **out of scope** — leave it.
- All money math routes through `round2` (round to 2 decimals).
- Two worktrees, both on branch `feat/per-ticket-service-fee`:
  - api: `/Users/lasliegeorgesjr/Documents/omevision/contracts/carrot-tickets/api-fee-wt`
  - landing: `/Users/lasliegeorgesjr/Documents/omevision/contracts/carrot-tickets/landing-fee-wt`

## File Structure

**api-fee-wt** (backend)
- Modify: `src/utils/serviceFee.util.ts` — add `quantity` to `computeServiceFee`; add `MAX_TICKETS_PER_ORDER`. Fee source of truth.
- Modify: `src/services/ticket.service.ts` — 3 call sites pass `quantity`.
- Modify: `src/controllers/public.controller.ts` — 3 Joi schemas use the constant.
- Modify: `src/controllers/tickets.controller.ts` — 1 Joi schema uses the constant.
- Create: `src/utils/__tests__/serviceFee.util.test.ts` — unit tests for the fee helper.

**landing-fee-wt** (web frontend)
- Create: `src/lib/pricing.ts` — pure helpers: `round2`, `serviceFeeForOrder`, `clampTicketQuantity`, `MAX_TICKETS_PER_ORDER`.
- Create: `src/lib/__tests__/pricing.test.ts` — unit tests.
- Modify: `src/components/PurchaseModal.tsx` — fee row uses `serviceFeeForOrder(...)`; drop the duplicated inline `round2`.
- Modify: `src/pages/EventPage.tsx` — stepper uses `clampTicketQuantity`; `+` button disabled at the capped bound.

---

## Task 1: Backend — per-ticket fee helper + call sites

**Files:**
- Modify: `api-fee-wt/src/utils/serviceFee.util.ts`
- Modify: `api-fee-wt/src/services/ticket.service.ts` (call sites ~L790, ~L961, ~L1099)
- Test: `api-fee-wt/src/utils/__tests__/serviceFee.util.test.ts`

**Interfaces:**
- Produces: `computeServiceFee(subtotal: number, quantity: number, method: PaymentMethod, cfg: ServiceFeeConfig): { serviceFeeAmount: number; amountCharged: number }`
- Produces: `serviceFeeFor(method: PaymentMethod, cfg: ServiceFeeConfig): number` (unchanged signature — the per-ticket amount)
- Produces: `MAX_TICKETS_PER_ORDER: number` (= 10) — consumed by Task 2
- Consumes: `PaymentMethod` from `@interfaces/ticket.interface`; `ServiceFeeConfig` from `PaymentConfigService.get()`

All commands run from `api-fee-wt/`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/serviceFee.util.test.ts`:

```ts
import { computeServiceFee, serviceFeeFor, round2, MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
import { PaymentMethod } from '@interfaces/ticket.interface';

const cfg = { keshlessServiceFee: 0, momoServiceFee: 5, cardServiceFee: 10 };

describe('serviceFeeFor', () => {
  it('returns the configured per-ticket amount per method', () => {
    expect(serviceFeeFor(PaymentMethod.MTN_MOMO, cfg)).toBe(5);
    expect(serviceFeeFor(PaymentMethod.PEACH_CARD, cfg)).toBe(10);
    expect(serviceFeeFor(PaymentMethod.KESHLESS_WALLET, cfg)).toBe(0);
  });
});

describe('computeServiceFee — per ticket', () => {
  it('multiplies the per-method fee by quantity (momo)', () => {
    expect(computeServiceFee(100, 1, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 5, amountCharged: 105 });
    expect(computeServiceFee(200, 2, PaymentMethod.MTN_MOMO, cfg)).toEqual({ serviceFeeAmount: 10, amountCharged: 210 });
  });

  it('multiplies the per-method fee by quantity (card)', () => {
    expect(computeServiceFee(300, 3, PaymentMethod.PEACH_CARD, cfg)).toEqual({ serviceFeeAmount: 30, amountCharged: 330 });
  });

  it('is zero for a zero-fee method regardless of quantity (wallet)', () => {
    expect(computeServiceFee(50, 4, PaymentMethod.KESHLESS_WALLET, cfg)).toEqual({ serviceFeeAmount: 0, amountCharged: 50 });
  });

  it('rounds the multiplied fee to 2 decimals', () => {
    const frac = { keshlessServiceFee: 0, momoServiceFee: 0.1, cardServiceFee: 0 };
    // 0.1 * 3 = 0.30000000000000004 in float — must round to 0.3
    expect(computeServiceFee(10, 3, PaymentMethod.MTN_MOMO, frac)).toEqual({ serviceFeeAmount: 0.3, amountCharged: 10.3 });
  });
});

describe('MAX_TICKETS_PER_ORDER', () => {
  it('is 10', () => {
    expect(MAX_TICKETS_PER_ORDER).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/utils/__tests__/serviceFee.util.test.ts`
Expected: FAIL — `MAX_TICKETS_PER_ORDER` is undefined and `computeServiceFee` arity/return is wrong (old flat behavior returns 5 for qty 2).

- [ ] **Step 3: Update the helper**

In `src/utils/serviceFee.util.ts`:

(a) Update the file/doc comment header from "FLAT amount … per payment method" to per-ticket. Replace the top doc block's first paragraph with:

```ts
/**
 * Buyer-paid service fee — a PER-TICKET amount (in E) added ON TOP of the
 * ticket subtotal at online checkout, varying per payment method. The buyer
 * pays the configured method fee for EACH ticket in the order (fee × quantity).
 * Single source of truth for the fee math; the checkout UI mirrors it
 * (landing src/lib/pricing.ts) so the amount displayed equals the amount charged.
 *
 * Distinct from platformFeePercent, which is a payout deduction the organizer
 * absorbs. Service fees apply to ONLINE sales only; POS / reseller stay at face.
 */
```

(b) Add the cap constant near the top (after the imports):

```ts
/** Hard cap on tickets a buyer may purchase in a single online order. */
export const MAX_TICKETS_PER_ORDER = 10;
```

(c) Update the doc comment on `serviceFeeFor` to read "The configured PER-TICKET fee for a method (0 for cash / anything without a fee)."

(d) Replace `computeServiceFee` with the quantity-aware version:

```ts
/** Compute the fee + total charged for a subtotal + method + ticket quantity. */
export function computeServiceFee(
  subtotal: number,
  quantity: number,
  method: PaymentMethod,
  cfg: ServiceFeeConfig
): ServiceFeeBreakdown {
  const serviceFeeAmount = round2(serviceFeeFor(method, cfg) * quantity);
  return { serviceFeeAmount, amountCharged: round2(subtotal + serviceFeeAmount) };
}
```

- [ ] **Step 4: Run the test to verify the helper passes**

Run: `npx jest src/utils/__tests__/serviceFee.util.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Update the 3 call sites in `src/services/ticket.service.ts`**

Keshless wallet (~L790) — `quantity` is already destructured from `params`:

```ts
    const { serviceFeeAmount } = computeServiceFee(
      totalAmount,
      quantity,
      PaymentMethod.KESHLESS_WALLET,
      feeCfg,
    );
```

MTN MoMo (~L959-962):

```ts
    const { serviceFeeAmount, amountCharged } =
      channel === SalesChannel.ONLINE
        ? computeServiceFee(totalAmount, p.quantity, PaymentMethod.MTN_MOMO, feeCfg)
        : { serviceFeeAmount: 0, amountCharged: totalAmount };
```

Peach card (~L1097-1100):

```ts
    const { serviceFeeAmount, amountCharged } =
      channel === SalesChannel.ONLINE
        ? computeServiceFee(totalAmount, p.quantity, PaymentMethod.PEACH_CARD, cardCfg)
        : { serviceFeeAmount: 0, amountCharged: totalAmount };
```

- [ ] **Step 6: Type-check the whole api to prove the call sites compile**

Run: `npx tsc --noEmit`
Expected: no errors (a missed call site would surface as "Expected 4 arguments, but got 3").

- [ ] **Step 7: Run the util test suite once more + commit**

Run: `npx jest src/utils/__tests__/serviceFee.util.test.ts`
Expected: PASS

```bash
git add src/utils/serviceFee.util.ts src/utils/__tests__/serviceFee.util.test.ts src/services/ticket.service.ts
git commit -m "feat(api): per-ticket service fee (configFee x quantity)

computeServiceFee now multiplies the per-method fee by ticket quantity;
wallet/momo/card online call sites pass quantity. totalAmount stays face;
amountCharged = totalAmount + fee x qty. Adds MAX_TICKETS_PER_ORDER.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — centralise the 10-per-order cap in validators

**Files:**
- Modify: `api-fee-wt/src/controllers/public.controller.ts` (3 Joi `quantity` schemas)
- Modify: `api-fee-wt/src/controllers/tickets.controller.ts` (1 Joi `quantity` schema, ~L207)

**Interfaces:**
- Consumes: `MAX_TICKETS_PER_ORDER` from `@utils/serviceFee.util` (Task 1)

This is a **non-behavioral DRY refactor** (value stays 10) — no unit test is added because the Joi schemas are inline and un-exported; correctness is proven by type-check + a grep asserting no magic `10` remains in these `quantity` rules. All commands from `api-fee-wt/`.

- [ ] **Step 1: Import the constant in `public.controller.ts`**

Add to the existing imports (match the file's alias style, e.g. alongside other `@utils` / `@services` imports):

```ts
import { MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
```

- [ ] **Step 2: Replace the 3 magic `max(10)` in `public.controller.ts`**

Each of the three `quantity` rules currently reads:

```ts
  quantity: Joi.number().integer().min(1).max(10).required(),
```

Change all three to:

```ts
  quantity: Joi.number().integer().min(1).max(MAX_TICKETS_PER_ORDER).required(),
```

- [ ] **Step 3: Do the same in `tickets.controller.ts`**

Add the import:

```ts
import { MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
```

Change the `quantity` rule (~L207) from `.max(10)` to `.max(MAX_TICKETS_PER_ORDER)`.

- [ ] **Step 4: Verify no magic-10 quantity rule remains + type-check**

Run:
```bash
grep -rn "quantity: Joi.number().integer().min(1).max(10)" src/controllers/public.controller.ts src/controllers/tickets.controller.ts || echo "OK: no magic-10 quantity rules remain"
npx tsc --noEmit
```
Expected: prints `OK: no magic-10 quantity rules remain`, and tsc reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/public.controller.ts src/controllers/tickets.controller.ts
git commit -m "refactor(api): centralise 10-per-order cap as MAX_TICKETS_PER_ORDER

No behavior change (still 10); removes the magic number from the online
buyer quantity validators.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend — pure pricing helpers

**Files:**
- Create: `landing-fee-wt/src/lib/pricing.ts`
- Test: `landing-fee-wt/src/lib/__tests__/pricing.test.ts`

**Interfaces:**
- Produces: `MAX_TICKETS_PER_ORDER: number` (= 10)
- Produces: `round2(x: number): number`
- Produces: `serviceFeeForOrder(perTicketFee: number, quantity: number): number` — `round2((perTicketFee || 0) * quantity)`
- Produces: `clampTicketQuantity(current: number, delta: number, available: number): number` — clamps `current + delta` to `[1, min(MAX_TICKETS_PER_ORDER, available)]`

All commands run from `landing-fee-wt/`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { round2, serviceFeeForOrder, clampTicketQuantity, MAX_TICKETS_PER_ORDER } from '@/lib/pricing';

describe('serviceFeeForOrder', () => {
  it('multiplies the per-ticket fee by quantity', () => {
    expect(serviceFeeForOrder(5, 1)).toBe(5);
    expect(serviceFeeForOrder(5, 2)).toBe(10);
    expect(serviceFeeForOrder(10, 3)).toBe(30);
  });
  it('is zero for a zero/undefined fee', () => {
    expect(serviceFeeForOrder(0, 4)).toBe(0);
    // @ts-expect-error guard against undefined fee from the method map
    expect(serviceFeeForOrder(undefined, 4)).toBe(0);
  });
  it('rounds to 2 decimals', () => {
    expect(serviceFeeForOrder(0.1, 3)).toBe(0.3);
  });
});

describe('clampTicketQuantity', () => {
  it('increments within bounds', () => {
    expect(clampTicketQuantity(1, 1, 100)).toBe(2);
  });
  it('never exceeds MAX_TICKETS_PER_ORDER even when availability is higher', () => {
    expect(clampTicketQuantity(10, 1, 100)).toBe(10);
    expect(MAX_TICKETS_PER_ORDER).toBe(10);
  });
  it('never exceeds availability when availability < max', () => {
    expect(clampTicketQuantity(3, 1, 3)).toBe(3);
  });
  it('never drops below 1', () => {
    expect(clampTicketQuantity(1, -1, 100)).toBe(1);
  });
});

describe('round2', () => {
  it('rounds to cents', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/pricing.test.ts`
Expected: FAIL — cannot resolve `@/lib/pricing` (module not created yet).

- [ ] **Step 3: Create the helper module**

Create `src/lib/pricing.ts`:

```ts
// Buyer-facing pricing math for online ticket checkout. Mirrors the backend
// source of truth (api src/utils/serviceFee.util.ts): the service fee is
// charged PER TICKET (configured per-method fee × quantity), and a single
// order is capped at MAX_TICKETS_PER_ORDER tickets. Keeping this pure and
// centralised means PurchaseModal and EventPage agree, and the amount shown
// equals the amount charged.

/** Hard cap on tickets a buyer may purchase in a single online order. */
export const MAX_TICKETS_PER_ORDER = 10;

/** Round to 2 decimals (cents), guarding against binary-float drift. */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Total service fee for an order: the per-ticket fee times the quantity. */
export function serviceFeeForOrder(perTicketFee: number, quantity: number): number {
  return round2((perTicketFee || 0) * quantity);
}

/**
 * Clamp a stepper change to a valid ticket quantity: at least 1, and no more
 * than the smaller of MAX_TICKETS_PER_ORDER and what's actually available.
 */
export function clampTicketQuantity(current: number, delta: number, available: number): number {
  const max = Math.min(MAX_TICKETS_PER_ORDER, available);
  return Math.max(1, Math.min(max, current + delta));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/pricing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricing.ts src/lib/__tests__/pricing.test.ts
git commit -m "feat(landing): pure pricing helpers (per-ticket fee + qty clamp)

serviceFeeForOrder(fee, qty) and clampTicketQuantity(current, delta, avail)
plus MAX_TICKETS_PER_ORDER — the frontend mirror of the backend fee math.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend — wire helpers into PurchaseModal + EventPage

**Files:**
- Modify: `landing-fee-wt/src/components/PurchaseModal.tsx` (~L74-76)
- Modify: `landing-fee-wt/src/pages/EventPage.tsx` (~L95-96 handler, ~L389 `+` disabled)

**Interfaces:**
- Consumes: `serviceFeeForOrder`, `round2`, `clampTicketQuantity`, `MAX_TICKETS_PER_ORDER` from `@/lib/pricing` (Task 3)

The pure logic is already unit-tested (Task 3); this task is thin substitution, verified by type-check, the existing PurchaseModal test staying green, and a manual UI check. All commands from `landing-fee-wt/`.

- [ ] **Step 1: Update PurchaseModal fee math**

In `src/components/PurchaseModal.tsx`, add to the imports (top of file, with the other `@/` imports):

```ts
import { serviceFeeForOrder, round2 } from '@/lib/pricing';
```

Replace the three lines at ~L74-76:

```ts
  const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
  const serviceFee = method ? round2(serviceFees[method] ?? 0) : 0;
  const total = round2(subtotal + serviceFee);
```

with (drop the inline `round2` — now imported):

```ts
  const serviceFee = method ? serviceFeeForOrder(serviceFees[method] ?? 0, quantity) : 0;
  const total = round2(subtotal + serviceFee);
```

- [ ] **Step 2: Update EventPage stepper**

In `src/pages/EventPage.tsx`, add to the imports:

```ts
import { clampTicketQuantity, MAX_TICKETS_PER_ORDER } from '@/lib/pricing';
```

Replace the increment handler body at ~L95-96:

```ts
    const newQuantity = quantity + delta;
    if (newQuantity >= 1 && newQuantity <= selectedTicketType.availableQuantity) {
      setQuantity(newQuantity);
    }
```

with:

```ts
    setQuantity(clampTicketQuantity(quantity, delta, selectedTicketType.availableQuantity));
```

Then update the `+` button's `disabled` expression at ~L389 from:

```ts
                            quantity >= (selectedTicketType?.availableQuantity || 0)
```

to:

```ts
                            quantity >= Math.min(MAX_TICKETS_PER_ORDER, selectedTicketType?.availableQuantity || 0)
```

- [ ] **Step 3: Type-check + run the existing frontend test suite**

Run:
```bash
npx tsc -b
npx vitest run src/components/__tests__/PurchaseModal.auth.test.tsx src/lib/__tests__/pricing.test.ts
```
Expected: tsc clean; both suites PASS (the auth test must still pass — the fee wiring doesn't touch the auth step).

- [ ] **Step 4: Manual UI verification**

Run `npm run dev`, open an event with a fee-carrying method, and confirm:
- The fee row shows `perTicketFee × quantity` (e.g. E5.00 at qty 1, E10.00 at qty 2 for MoMo), and the displayed total equals subtotal + that fee.
- The quantity stepper stops at 10 even when far more tickets are available; the `+` button disables at 10.

(If a Playwright MCP session is available, capture the checkout modal at qty 1 and qty 2 as evidence.)

- [ ] **Step 5: Commit**

```bash
git add src/components/PurchaseModal.tsx src/pages/EventPage.tsx
git commit -m "feat(landing): per-ticket fee display + hard 10-ticket stepper cap

PurchaseModal fee row = perTicketFee x quantity (via serviceFeeForOrder);
EventPage stepper clamps to min(10, available) so a buyer can't exceed the
backend cap. Drops the duplicated inline round2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Per-method fee × qty (wallet/momo/card) → Task 1 (helper + 3 call sites). ✓
- `amountCharged = totalAmount + fee×qty`, `totalAmount` stays face → Task 1 helper + unchanged downstream (`sellTickets` recompute, MoMo/card store `amountCharged`). ✓
- Frontend fee mirror × qty → Task 3 (`serviceFeeForOrder`) + Task 4 (PurchaseModal). ✓
- Max 10 per order, backend → Task 2 (constant in 4 validators). ✓
- Max 10 per order, UI → Task 3 (`clampTicketQuantity`) + Task 4 (EventPage stepper + `+` disabled). ✓
- Reseller `max(20)` untouched → not referenced in any task. ✓
- DRY (one backend home, one frontend home; removes duplicated round2) → Tasks 1, 3, 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code and exact commands with expected output. ✓

**Type consistency:** `computeServiceFee(subtotal, quantity, method, cfg)` used identically in Task 1 helper and all 3 call sites; `MAX_TICKETS_PER_ORDER` exported from `@utils/serviceFee.util` (Task 1) and consumed in Task 2; `serviceFeeForOrder`/`clampTicketQuantity`/`round2`/`MAX_TICKETS_PER_ORDER` defined in Task 3 and consumed with matching signatures in Task 4. ✓

**Note on baseline:** Before Task 1, run `npm install` and the existing test suites in both worktrees to confirm a clean starting point (`api-fee-wt`: `npx jest`; `landing-fee-wt`: `npx vitest run`). If pre-existing failures appear, report before proceeding.
